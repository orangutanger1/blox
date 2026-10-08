// Python that runs on Kaggle for `blox image`. Kept free of backticks and
// dollar-brace so it embeds in template strings untouched.

export const RUNTIME_DATASET = 'tamadaresearch/qwen-image21-t4-runtime';
export const WEIGHTS_SLUG = 'blox-qwen21-weights';
export const BATCH_SLUG = 'blox-image-batch';
// The tamadaresearch notebook's pinned image (PyTorch >= 2.8, CUDA for T4 x2).
export const DOCKER_IMAGE = 'gcr.io/kaggle-private-byod/python@sha256:37c64f7dd9c54116ecd1bcc88817c5469b88387388fade02bfa8bf3fc647d461';
export const WEIGHTS_REVISION = 'ace0edeb3791a594ddfa36ed5f41a178a394e921';
export const WEIGHT_FILES: Record<string, number> = {
  'diffusion_models/qwen_image_2.1_int8_convrot.safetensors': 7256783064,
  'text_encoders/qwen3vl_8b_int8_convrot.safetensors': 9350798360,
  'vae/qwen_image_2.1_vae_bf16.safetensors': 675509688,
};

// One-time, CPU only: copy the pinned Comfy-Org weights into this kernel's
// output, which batch kernels attach through kernel_sources.
export function weightsScript(): string {
  return `# blox: one-time copy of the pinned Comfy-Org Qwen-Image-2.1 int8 weights into this
# kernel's output, so blox's image batches can attach them (kernel_sources).
# Weights: Qwen Research License (non-commercial).
import os, subprocess, time
REV = "${WEIGHTS_REVISION}"
BASE = "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/" + REV + "/"
FILES = ${JSON.stringify(WEIGHT_FILES)}
out = "/kaggle/working"
for path, size in FILES.items():
    dest = os.path.join(out, os.path.basename(path))
    t = time.time()
    subprocess.run(["curl", "-L", "--fail", "--retry", "5", "-sS", "-o", dest, BASE + path], check=True)
    got = os.path.getsize(dest)
    print(path, got, "ok" if got == size else "SIZE MISMATCH want %d" % size, "%.0fs" % (time.time() - t), flush=True)
    assert got == size
print("done")
`;
}

// Runs under ComfyUI's venv: loads the three models once, then every item.
const DRIVER = `import json, sys, time, traceback
comfy_dir, src, out, items_file, size = sys.argv[1:6]
size = int(size)
sys.path.insert(0, comfy_dir)
sys.path.insert(0, src)
import comfy.options
comfy.options.enable_args_parsing()
sys.argv = ["comfy-t4", "--use-pytorch-cross-attention", "--fp32-vae", "--disable-dynamic-vram", "--disable-comfy-compiler", "--preview-method", "none"]
import comfy.quant_ops
import torch
import numpy as np
from PIL import Image
import folder_paths, nodes
from comfy_extras.nodes_qwen import TextEncodeQwenImage21
from device_nodes import QwenT4TextEncoderLoader
from attention_backend import select_backend
from workflow import MODEL, ENCODER, VAE
folder_paths.set_output_directory(out)
items = json.load(open(items_file))
results = []
def save():
    json.dump({"status": "RUNNING", "results": results}, open(out + "/results.json", "w"), indent=1)
with torch.inference_mode():
    clip = QwenT4TextEncoderLoader().load_clip(ENCODER, 1)[0]
    conds = {}
    for it in items:
        try:
            enc = TextEncodeQwenImage21.execute(clip, it["prompt"], it.get("negative", ""), resolution=512)
            conds[it["file"]] = (enc[0], enc[1])
        except Exception as e:
            results.append({"file": it["file"], "error": "encode: %s: %s" % (type(e).__name__, e)})
    model = nodes.UNETLoader().load_unet(MODEL, "default")[0]
    model = select_backend(model, "int8")
    vae = nodes.VAELoader().load_vae(VAE)[0]
    for it in items:
        if it["file"] not in conds:
            continue
        t = time.time()
        try:
            positive, negative = conds[it["file"]]
            latent = {"samples": torch.zeros(1, 64, size // 16, size // 16)}
            sampled = nodes.KSampler().sample(model, it["seed"], it.get("steps", 40), 1.0, "euler", "simple", positive, negative, latent, denoise=1.0)
            decoded = nodes.VAEDecode().decode(vae, sampled[0])[0]
            px = (decoded[0].float().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
            mode = "RGBA" if px.shape[-1] == 4 else "RGB"
            Image.fromarray(px, mode).save(out + "/" + it["file"])
            results.append({"file": it["file"], "seed": it["seed"], "channels": int(px.shape[-1]), "seconds": round(time.time() - t, 1)})
        except Exception as e:
            results.append({"file": it["file"], "error": "%s: %s" % (type(e).__name__, e), "trace": traceback.format_exc()[-1500:]})
        save()
        print(json.dumps(results[-1])[:300], flush=True)
json.dump({"status": "DONE", "results": results}, open(out + "/results.json", "w"), indent=1)
`;

export interface KernelItem {
  file: string; // output PNG name
  prompt: string;
  negative?: string;
  seed: number;
  steps?: number;
}

export function batchScript(items: KernelItem[], size: number): string {
  return `# blox image batch: Qwen-Image-2.1 (int8, T4 x2) via the tamadaresearch runtime (GPL-3.0),
# weights from the user's own kernel output (Qwen Research License, non-commercial).
import glob, json, os, subprocess, sys
from pathlib import Path
OUT = "/kaggle/working/out"
os.makedirs(OUT, exist_ok=True)
ITEMS = json.loads(${JSON.stringify(JSON.stringify(items))})
SIZE = ${size}
def fail(msg):
    json.dump({"status": "FAILED", "error": msg, "results": []}, open(OUT + "/results.json", "w"), indent=1)
    raise SystemExit(msg)
found = glob.glob("/kaggle/input/**/run_local.py", recursive=True)
if not found:
    fail("runtime dataset ${RUNTIME_DATASET} is not attached")
src = os.path.dirname(found[0])
sys.path.insert(0, src)
from environment import MANIFEST, setup
from local_weights import link_weights, verify_weights
from workflow import MODEL, ENCODER, VAE
try:
    selected, records = verify_weights(MANIFEST, Path("/kaggle/input"), {"diffusion_models/" + MODEL: "", "text_encoders/" + ENCODER: "", "vae/" + VAE: ""})
except Exception as e:
    fail("weights: %s: %s (run blox image setup)" % (type(e).__name__, e))
ws = Path("/tmp/qwen21-code-only")
os.environ.update(HF_HOME=str(ws / "hf-cache"), HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false")
comfy, python = setup(ws, Path(OUT), "auto", minimum_free_gib=12)
link_weights(selected, comfy / "models")
Path("/tmp/blox_driver.py").write_text(${JSON.stringify(DRIVER)})
Path("/tmp/blox_items.json").write_text(json.dumps(ITEMS))
subprocess.run([str(python), "-u", "/tmp/blox_driver.py", str(comfy), src, OUT, "/tmp/blox_items.json", str(SIZE)], check=True, timeout=6 * 3600)
for name in ("base-runtime.json", "installed-packages.txt"):
    p = Path(OUT) / name
    if p.exists():
        p.unlink()
print("done")
`;
}
