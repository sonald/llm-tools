# QRCode Monkey Fixtures

These PNG fixtures are committed so the default `cargo test` path stays fully offline and reproducible.

- `qrcode-monkey-url.png`: generated from QRCode Monkey content `https://example.com/qrcode2txt-live?case=url&ts=2026-04-14`
- `qrcode-monkey-text.png`: generated from QRCode Monkey content `qrcode2txt live test\nline two: \u4F60\u597D QR`

Refresh them with:

```bash
./scripts/fetch_qrcode_monkey_fixtures.sh
```

The refresh script uses the official QRCode Monkey `/qr/custom` endpoint documented at:

- https://www.qrcode-monkey.com/qr-code-api-with-logo/
