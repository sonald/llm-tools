use std::fs::{self, File};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[cfg(unix)]
use std::os::unix::fs::FileExt;
#[cfg(windows)]
use std::os::windows::fs::FileExt;

const MAX_READ_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileIdentity {
    pub canonical_path: PathBuf,
    pub size: u64,
    pub modified: SystemTime,
}

#[derive(Debug)]
pub struct FileSource {
    file: File,
    identity: FileIdentity,
}

#[derive(Debug, Eq, PartialEq)]
pub struct ReadChunk {
    pub start: u64,
    pub bytes: Vec<u8>,
    pub has_more: bool,
    pub next_offset: Option<u64>,
}

impl FileSource {
    pub fn open(path: &Path) -> io::Result<Self> {
        let canonical_path = fs::canonicalize(path)?;
        let file = File::open(&canonical_path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(ErrorKind::InvalidInput.into());
        }

        Ok(Self {
            file,
            identity: FileIdentity {
                canonical_path,
                size: metadata.len(),
                modified: metadata.modified()?,
            },
        })
    }

    pub fn identity(&self) -> &FileIdentity {
        &self.identity
    }

    pub fn is_current(&self) -> bool {
        let Ok(metadata) = fs::metadata(&self.identity.canonical_path) else {
            return false;
        };

        metadata.is_file()
            && metadata.len() == self.identity.size
            && metadata
                .modified()
                .is_ok_and(|modified| modified == self.identity.modified)
    }

    pub fn read_chunk(&self, offset: u64, requested_len: usize) -> io::Result<ReadChunk> {
        if requested_len == 0 {
            return Err(ErrorKind::InvalidInput.into());
        }
        if !self.is_current() {
            return Err(ErrorKind::InvalidData.into());
        }
        if offset >= self.identity.size {
            return Ok(ReadChunk {
                start: offset,
                bytes: Vec::new(),
                has_more: false,
                next_offset: None,
            });
        }

        let remaining = self.identity.size - offset;
        let mut read_len = requested_len.min(MAX_READ_BYTES);
        if remaining < read_len as u64 {
            read_len = remaining as usize;
        }

        let mut bytes = vec![0; read_len];
        let mut filled = 0usize;
        while filled < read_len {
            let absolute_offset = offset
                .checked_add(filled as u64)
                .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
            let read = match read_at(&self.file, &mut bytes[filled..], absolute_offset) {
                Ok(read) => read,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            };
            if read == 0 {
                break;
            }
            filled += read;
        }
        bytes.truncate(filled);

        let end = offset
            .checked_add(filled as u64)
            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
        let has_more = end < self.identity.size;
        let next_offset = if has_more { Some(end) } else { None };

        Ok(ReadChunk {
            start: offset,
            bytes,
            has_more,
            next_offset,
        })
    }
}

#[cfg(unix)]
fn read_at(file: &File, bytes: &mut [u8], offset: u64) -> io::Result<usize> {
    file.read_at(bytes, offset)
}

#[cfg(windows)]
fn read_at(file: &File, bytes: &mut [u8], offset: u64) -> io::Result<usize> {
    file.seek_read(bytes, offset)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::thread;

    use super::*;

    fn temp_path(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        std::env::temp_dir().join(format!("{prefix}-{}-{}.tmp", std::process::id(), nanos))
    }

    #[test]
    fn opens_canonical_identity_and_reads_requested_range() {
        let path = temp_path("file-source-range");
        fs::write(&path, b"abcdefgh").unwrap();

        let source = FileSource::open(&path).unwrap();
        assert_eq!(
            source.identity().canonical_path,
            fs::canonicalize(&path).unwrap()
        );
        let chunk = source.read_chunk(2, 4).unwrap();
        assert_eq!(chunk.bytes, b"cdef");
        assert!(chunk.has_more);
        assert_eq!(chunk.next_offset, Some(6));

        drop(source);
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn caps_huge_requests_to_max_read_bytes() {
        let path = temp_path("file-source-cap");
        let mut contents = vec![b'x'; MAX_READ_BYTES + 10];
        contents[..10].copy_from_slice(b"0123456789");
        fs::write(&path, contents).unwrap();

        let source = FileSource::open(&path).unwrap();
        let chunk = source.read_chunk(0, usize::MAX).unwrap();
        assert_eq!(chunk.bytes.len(), MAX_READ_BYTES);
        assert_eq!(&chunk.bytes[..10], b"0123456789");
        assert!(chunk.has_more);
        assert_eq!(chunk.next_offset, Some(MAX_READ_BYTES as u64));

        drop(source);
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn handles_eof_and_rejects_zero_length_reads() {
        let path = temp_path("file-source-eof");
        fs::write(&path, b"abc").unwrap();

        let source = FileSource::open(&path).unwrap();
        let chunk = source.read_chunk(3, 8).unwrap();
        assert!(chunk.bytes.is_empty());
        assert!(!chunk.has_more);
        assert_eq!(chunk.next_offset, None);
        assert_eq!(
            source.read_chunk(0, 0).unwrap_err().kind(),
            ErrorKind::InvalidInput
        );

        drop(source);
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn interleaved_concurrent_reads_keep_absolute_offsets_independent() {
        let path = temp_path("file-source-interleaved");
        let contents = (0..1024u32).flat_map(u32::to_le_bytes).collect::<Vec<_>>();
        fs::write(&path, &contents).unwrap();
        let source = Arc::new(FileSource::open(&path).unwrap());

        let handles = (0..4)
            .map(|worker| {
                let source = Arc::clone(&source);
                let contents = contents.clone();
                thread::spawn(move || {
                    for round in 0..64 {
                        let word = (worker * 67 + round * 31) % 1024;
                        let offset = (word * 4) as u64;
                        let chunk = source.read_chunk(offset, 4).unwrap();
                        let start = offset as usize;
                        assert_eq!(chunk.bytes, contents[start..start + 4]);
                        assert!(!chunk.has_more || chunk.next_offset == Some(offset + 4));
                    }
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().expect("concurrent read should not panic");
        }

        drop(source);
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn rejects_stale_identity_after_size_change() {
        let path = temp_path("file-source-stale");
        fs::write(&path, b"abcdef").unwrap();

        let source = FileSource::open(&path).unwrap();
        fs::write(&path, b"abc").unwrap();
        assert!(!source.is_current());
        assert_eq!(
            source.read_chunk(0, 8).unwrap_err().kind(),
            ErrorKind::InvalidData
        );

        drop(source);
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn rejects_directory_input() {
        let path = temp_path("file-source-dir");
        fs::create_dir(&path).unwrap();

        let result = FileSource::open(&path);
        assert_eq!(result.unwrap_err().kind(), ErrorKind::InvalidInput);

        fs::remove_dir(&path).unwrap();
    }
}
