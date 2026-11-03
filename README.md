# Lamhaat

A photo library for Windows. It sorts your shoots, helps you pick the keepers, and publishes albums to your own free website on GitHub Pages. The AI runs on your PC, so your photos stay with you.

## Install

1. Download **Lamhaat-Setup-x.y.z.exe** from [Releases](../../releases).
2. Run it. You don't need to be an administrator. It installs into your user folder, adds Desktop and Start menu shortcuts, and opens Lamhaat.
3. On first start, Lamhaat checks your PC for the free programs it uses. If any are missing, it lists them with their sizes and downloads them when you click **Download them**:

| Program | What it's for | Size |
|---|---|---|
| Git | Publishing albums to GitHub | 50 MB |
| Ollama | The local AI server | 1 GB |
| Vision model (qwen2.5vl:7b) | Describing photos and finding people | 6 GB |
| Real-ESRGAN (optional) | AI upscaling | 45 MB |
| LibRaw (optional) | RAW photos (.RAF, .DNG, .NEF, .CR3 …) | 3 MB |

Lamhaat uses programs that are already installed rather than downloading them again. To see what's installed or running, open **Settings → Programs Lamhaat uses**. From there you can start or restart the AI server and download anything that's missing. Lamhaat starts the AI server when it opens, and starts it again if it finds it has stopped.

Requires Windows 10 or 11, 64-bit. A graphics card with 8 GB or more makes the AI faster, but it isn't required.

## What it does

- **Review:** flags blur, motion blur, closed eyes, noise, tilted horizons, screenshots and accidental shots. Groups bursts, and lets you keep or reject photos with K / X.
- **Albums:** arranges photos into chapters by day, place, scene or your own tags, and marks highlights.
- **Publish:** a fast static site on GitHub Pages:
  - full-size originals
  - search by meaning ("kids at the beach")
  - filters, a timeline and an optional map
  - private albums, encrypted and opened only by the people you add
  - favourites and comments
- **Enhance:** AI upscaling and sharpening, plus RAW development. The original is never changed.

## Your data

Your library is kept in `%USERPROFILE%\Lamhaat`, and your photos stay in your own folders. Settings has a recovery code for private albums. Save it somewhere safe.

## Building from source

```
npm install
node desktop/server.js           # run it
node scripts/package.mjs         # dist\Lamhaat-Setup-<version>.exe
```

## License

MIT
