# Lamhaat's darkroom, run with a Python that has PyTorch (ComfyUI's, on this PC). Two jobs:
#   develop  a RAW file (Fuji .RAF and the rest LibRaw reads) into a full-size picture, with the
#            camera's white balance and no noise reduction of its own
#   denoise  remove noise with SCUNet (a model trained on real camera noise), on the graphics card,
#            in tiles so any size fits; a little of the original is mixed back so it doesn't look waxy
# usage: python develop.py jobs.json   jobs: [{"in", "out", "raw": bool, "denoise": bool, "strength": 0..1}]
# Prints one JSON line per step: {"i": job, "p": 0..1} ... {"i": job, "done": true} or {"i": job, "error": "..."}
import json, os, sys
HERE = os.environ.get('LAMHAAT_TOOLS', '')
sys.path.insert(0, os.path.join(HERE, 'py'))
import numpy as np
from PIL import Image, ImageOps

say = lambda **k: print(json.dumps(k), flush=True)
model = None

def load(job):
    if job.get('raw'):
        import rawpy
        with rawpy.imread(job['in']) as r:
            rgb = r.postprocess(use_camera_wb=True, output_bps=16, no_auto_bright=False)  # turned the right way by LibRaw
        return rgb.astype(np.float32) / 65535.0, None
    im = Image.open(job['in'])
    exif = im.info.get('exif')
    im = ImageOps.exif_transpose(im).convert('RGB')
    return np.asarray(im, dtype=np.float32) / 255.0, exif

def denoise(img, i, strength):
    global model
    import torch, spandrel
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    if model is None:
        model = spandrel.ModelLoader().load_from_file(os.path.join(HERE, 'models', 'scunet_color_real_psnr.pth')).model.eval().to(dev)
        if dev == 'cuda': model = model.half()
    T, O = 768, 32  # tile, and the overlap each tile drops at its edges
    h, w, _ = img.shape
    out = np.empty_like(img)
    tiles = [(y, x) for y in range(0, h, T) for x in range(0, w, T)]
    with torch.inference_mode():
        for n, (y, x) in enumerate(tiles):
            y0, x0, y1, x1 = max(0, y - O), max(0, x - O), min(h, y + T + O), min(w, x + T + O)
            t = torch.from_numpy(np.ascontiguousarray(img[y0:y1, x0:x1].transpose(2, 0, 1)))[None].to(dev)
            r = model(t.half() if dev == 'cuda' else t).float().clamp(0, 1)[0].cpu().numpy().transpose(1, 2, 0)
            out[y:min(h, y + T), x:min(w, x + T)] = r[y - y0:y - y0 + min(T, h - y), x - x0:x - x0 + min(T, w - x)]
            say(i=i, p=(n + 1) / len(tiles))
    return img * (1 - strength) + out * strength

jobs = json.load(open(sys.argv[1], encoding='utf-8'))
for i, job in enumerate(jobs):
    try:
        img, exif = load(job)
        if job.get('denoise'): img = denoise(img, i, float(job.get('strength', 0.85)))
        pic = Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8))
        tmp = job['out'] + '.part'
        pic.save(tmp, 'JPEG', quality=96, subsampling=0, **({'exif': exif} if exif else {}))
        os.replace(tmp, job['out'])
        say(i=i, done=True, w=pic.width, h=pic.height)
    except Exception as e:
        say(i=i, error=str(e)[:300])
