---
"lossless-claw": patch
---

Fix `doctor-contract` model reference generation to honor the explicit `provider` field in `fallbackProviders` when the model value also contains a slash, preventing false "Missing allowedModels entries" override-policy warnings.
