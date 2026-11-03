# One-off build step: turn the SCUNet denoise model (PyTorch .pth) into ONNX, so Lamhaat can run it without
# Python (onnxruntime, on the graphics card through DirectML). Fixed 768 x 768 tiles: the app cuts photos
# into tiles of that size (padding the edges), which also keeps the graphics memory it needs small.
# usage: python scripts/export-scunet.py <scunet_color_real_psnr.pth> <out.onnx>
import sys, torch, spandrel
model = spandrel.ModelLoader().load_from_file(sys.argv[1]).model.eval()
x = torch.rand(1, 3, 768, 768)
with torch.no_grad():
    torch.onnx.export(model, x, sys.argv[2], input_names=['image'], output_names=['clean'], opset_version=17, do_constant_folding=True)
    ref = model(x)
import onnxruntime as ort
s = ort.InferenceSession(sys.argv[2])
out = s.run(None, {'image': x.numpy()})[0]
print('max difference torch vs onnx:', float(abs(out - ref.numpy()).max()))
