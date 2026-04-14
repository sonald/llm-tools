use anyhow::{anyhow, Context, Result};
use image::DynamicImage;

pub fn decode_qr_texts(image: &DynamicImage) -> Result<Vec<String>> {
    let grayscale = image.to_luma8();
    let mut prepared = rqrr::PreparedImage::prepare(grayscale);
    let grids = prepared.detect_grids();

    if grids.is_empty() {
        return Err(anyhow!("no QR codes detected"));
    }

    let mut decoded = Vec::new();
    let mut failures = Vec::new();

    for (index, grid) in grids.into_iter().enumerate() {
        match grid
            .decode()
            .with_context(|| format!("failed to decode QR candidate {index}"))
        {
            Ok((_meta, content)) => decoded.push(content),
            Err(err) => failures.push(err.to_string()),
        }
    }

    if decoded.is_empty() {
        let message = failures
            .into_iter()
            .next()
            .unwrap_or_else(|| "QR codes were detected but none could be decoded".to_string());
        return Err(anyhow!(message));
    }

    Ok(decoded)
}
