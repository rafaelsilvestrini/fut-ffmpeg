# fut-ffmpeg

## Production

Use the Dockerfile in production. It installs Chromium, ffmpeg and the Linux shared libraries required by Puppeteer, including `libnspr4`.

```bash
docker build -t fut-ffmpeg .
docker run --rm -p 3000:3000 fut-ffmpeg
```

The app uses `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` inside Docker, so Puppeteer does not need to download or run its cached Chrome build.

## EasyPanel

In EasyPanel, deploy this project using the repository Dockerfile. Make sure the public domain configured for the app is `fibrazil.es` or a subdomain such as `api.fibrazil.es`; direct access by server IP will be rejected by the app origin filter.
