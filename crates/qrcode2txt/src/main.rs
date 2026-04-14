use clap::Parser;

use qrcode2txt::{cli::Cli, ExitCode};

fn main() {
    let exit_code = match Cli::try_parse() {
        Ok(cli) => match qrcode2txt::run(cli) {
            Ok(code) => code,
            Err(error) => {
                eprintln!("{error}");
                error.exit_code()
            }
        },
        Err(error) => {
            error.print().expect("failed to print clap error");
            ExitCode::Usage
        }
    };

    std::process::exit(exit_code as i32);
}
