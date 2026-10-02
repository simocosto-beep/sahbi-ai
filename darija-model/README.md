# Sahbi Darija Model

Commercial-oriented Moroccan Darija language model project.

## Goal

Fine-tune an open-weight multilingual base model specifically for Moroccan Darija:
- Arabic-script Darija
- Latin/Arabizi Darija (3, 7, 9, etc.)
- French/Darija code-switching
- Moroccan idioms, tone, humor and conversational style
- instruction following, customer support, translation and assistant use cases

The initial base is **Qwen/Qwen3-8B**, whose model card declares the **Apache-2.0** license. Verify the upstream model license again before every public release of weights.

## Product strategy

1. Build a high-quality licensed dataset.
2. Fine-tune with QLoRA.
3. Evaluate on a fixed Darija benchmark.
4. Merge/export weights.
5. Serve an OpenAI-compatible API.
6. Offer:
   - hosted API,
   - private enterprise deployment,
   - downloadable weights/adapters where license terms permit.

## Dataset policy

Only use:
- synthetic examples created for this project,
- public data with compatible licensing,
- user-contributed data with explicit permission.

Do not silently train on private Sahbi conversations.

## Quick start

Python 3.11+ and an NVIDIA CUDA GPU are recommended.

```bash
cd darija-model
pip install -r requirements.txt
python train_qlora.py --dataset data/seed.jsonl
python eval_darija.py --model outputs/sahbi-darija-lora
```

For production training, replace the seed data with a much larger curated dataset and run on a GPU host.

## Target releases

- `Sahbi-Darija-8B-Alpha`: first LoRA adapter.
- `Sahbi-Darija-8B`: merged and benchmarked model.
- `Sahbi-Darija-API`: hosted commercial API.
