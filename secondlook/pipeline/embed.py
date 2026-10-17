"""Stage 3: frozen encoders. Nothing here is ever fine-tuned.

Pathology encoders (vision-language, so they also embed text prompts):
  quiltnet  - open_clip hf-hub:wisdomik/QuiltNet-B-32 (MIT)
  plip      - transformers vinid/plip
  pathgen   - open_clip ViT-B-16 + jamessyx/PathGen-CLIP (gated: needs HF_TOKEN + accepted terms)
  conch / musk - only if weights and approval exist (raise ModelUnavailable otherwise)
Controls (image only):
  imagenet  - torchvision ViT-B/16 IMAGENET1K_V1, CLS token
  colorhist - 8x8x8 RGB histogram, Hellinger-normalised (no torch needed)
"""
from __future__ import annotations

import os
from functools import lru_cache

import numpy as np

MODEL_VERSIONS = {
    "quiltnet": "hf-hub:wisdomik/QuiltNet-B-32",
    "plip": "hf:vinid/plip",
    "pathgen": "hf:jamessyx/PathGen-CLIP/pathgenclip.pt (open_clip ViT-B-16)",
    "imagenet": "torchvision:vit_b_16/IMAGENET1K_V1",
    "colorhist": "rgb_hist_8x8x8_hellinger_v1",
}


class ModelUnavailable(RuntimeError):
    pass


def _device():
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


class Encoder:
    name: str
    dim: int
    has_text: bool = False

    def encode_images(self, batch_uint8: np.ndarray) -> np.ndarray:  # [B,H,W,3] -> [B,D] L2-normalised
        raise NotImplementedError

    def encode_text(self, texts: list[str]) -> np.ndarray:
        raise ModelUnavailable(f"{self.name} has no text tower")

    @property
    def logit_scale(self) -> float:
        return 100.0


class _TorchVisionEncoder(Encoder):
    """Shared preprocessing: uint8 -> float tensor, resize 224, normalise."""

    mean = (0.48145466, 0.4578275, 0.40821073)  # CLIP
    std = (0.26862954, 0.26130258, 0.27577711)

    def _prep(self, batch: np.ndarray):
        import torch
        import torch.nn.functional as F

        t = torch.from_numpy(np.ascontiguousarray(batch)).to(self.device).permute(0, 3, 1, 2).float() / 255.0
        if t.shape[-1] != 224 or t.shape[-2] != 224:
            t = F.interpolate(t, size=(224, 224), mode="bicubic", align_corners=False, antialias=True)
        m = torch.tensor(self.mean, device=self.device).view(1, 3, 1, 1)
        s = torch.tensor(self.std, device=self.device).view(1, 3, 1, 1)
        t = (t - m) / s
        return t.half() if self.device == "cuda" else t

    @staticmethod
    def _norm(x) -> np.ndarray:
        x = x.float()
        x = x / x.norm(dim=-1, keepdim=True).clamp_min(1e-6)
        return x.cpu().numpy().astype(np.float32)


class OpenClipEncoder(_TorchVisionEncoder):
    has_text = True

    def __init__(self, name: str, arch: str | None, pretrained: str):
        import open_clip
        import torch

        self.name = name
        self.device = _device()
        if pretrained.startswith("hf-hub:"):
            model, _, _ = open_clip.create_model_and_transforms(pretrained)
            self.tokenizer = open_clip.get_tokenizer(pretrained)
        else:
            model, _, _ = open_clip.create_model_and_transforms(arch, pretrained=pretrained)
            self.tokenizer = open_clip.get_tokenizer(arch)
        model.eval().to(self.device)
        if self.device == "cuda":
            model = model.half()
        self.model = model
        with torch.no_grad():
            self._scale = float(model.logit_scale.exp().item())
        self.dim = int(model.visual.output_dim)

    @property
    def logit_scale(self) -> float:
        return self._scale

    def encode_images(self, batch):
        import torch

        with torch.no_grad():
            return self._norm(self.model.encode_image(self._prep(batch)))

    def encode_text(self, texts):
        import torch

        with torch.no_grad():
            tok = self.tokenizer(texts).to(self.device)
            return self._norm(self.model.encode_text(tok))


class HFClipEncoder(_TorchVisionEncoder):
    has_text = True

    def __init__(self, name: str, repo: str):
        import torch
        from transformers import CLIPModel, CLIPTokenizer

        self.name = name
        self.device = _device()
        model = CLIPModel.from_pretrained(repo).eval().to(self.device)
        if self.device == "cuda":
            model = model.half()
        self.model = model
        self.tokenizer = CLIPTokenizer.from_pretrained(repo)
        self.dim = int(model.config.projection_dim)
        with torch.no_grad():
            self._scale = float(model.logit_scale.exp().item())

    @property
    def logit_scale(self) -> float:
        return self._scale

    def encode_images(self, batch):
        import torch

        with torch.no_grad():
            return self._norm(_features(self.model.get_image_features(pixel_values=self._prep(batch))))

    def encode_text(self, texts):
        import torch

        with torch.no_grad():
            tok = self.tokenizer(texts, padding=True, truncation=True, max_length=77, return_tensors="pt").to(self.device)
            return self._norm(_features(self.model.get_text_features(**tok)))


def _features(out):
    """transformers<5 returns a tensor; >=5 returns an output whose pooler_output is projected."""
    return out if hasattr(out, "float") else out.pooler_output


class ImageNetViT(_TorchVisionEncoder):
    mean = (0.485, 0.456, 0.406)
    std = (0.229, 0.224, 0.225)

    def __init__(self):
        import torchvision

        self.name = "imagenet"
        self.device = _device()
        m = torchvision.models.vit_b_16(weights=torchvision.models.ViT_B_16_Weights.IMAGENET1K_V1)
        m.heads = __import__("torch").nn.Identity()
        m.eval().to(self.device)
        self.model = m.half() if self.device == "cuda" else m
        self.dim = 768

    def encode_images(self, batch):
        import torch

        with torch.no_grad():
            return self._norm(self.model(self._prep(batch)))


class ColorHist(Encoder):
    name = "colorhist"
    dim = 512

    def encode_images(self, batch):
        q = (batch.astype(np.uint16) // 32).reshape(batch.shape[0], -1, 3)  # 8 bins/channel
        codes = q[..., 0] * 64 + q[..., 1] * 8 + q[..., 2]
        out = np.zeros((batch.shape[0], 512), np.float32)
        for i in range(batch.shape[0]):
            out[i] = np.bincount(codes[i], minlength=512)
        out = np.sqrt(out / out.sum(axis=1, keepdims=True))  # Hellinger => unit L2 norm
        return out


@lru_cache(maxsize=None)
def get_encoder(name: str) -> Encoder:
    if name == "quiltnet":
        return OpenClipEncoder("quiltnet", None, "hf-hub:wisdomik/QuiltNet-B-32")
    if name == "plip":
        return HFClipEncoder("plip", "vinid/plip")
    if name == "pathgen":
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        try:
            from huggingface_hub import hf_hub_download

            path = hf_hub_download("jamessyx/PathGen-CLIP", "pathgenclip.pt", token=token)
        except Exception as e:
            raise ModelUnavailable(f"PathGen-CLIP weights are gated ({type(e).__name__}); "
                                   "accept the terms on Hugging Face and set HF_TOKEN") from e
        return OpenClipEncoder("pathgen", "ViT-B-16", path)
    if name == "imagenet":
        return ImageNetViT()
    if name == "colorhist":
        return ColorHist()
    if name in ("conch", "musk"):
        raise ModelUnavailable(f"{name} weights are not approved for this project yet")
    raise KeyError(name)


def available_models(names) -> list[str]:
    ok = []
    for n in names:
        try:
            get_encoder(n)
            ok.append(n)
        except ModelUnavailable as e:
            print(f"[embed] skipping {n}: {e}")
    return ok
