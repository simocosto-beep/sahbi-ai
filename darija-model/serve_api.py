import os

import torch
from fastapi import FastAPI, HTTPException
from peft import PeftModel
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer

BASE_MODEL = os.getenv("BASE_MODEL", "Qwen/Qwen3-8B")
ADAPTER = os.getenv("ADAPTER_PATH", "outputs/sahbi-darija-lora")

app = FastAPI(title="Sahbi Darija API", version="0.1.0")

tokenizer = AutoTokenizer.from_pretrained(ADAPTER)
base = AutoModelForCausalLM.from_pretrained(
    BASE_MODEL,
    device_map="auto",
    torch_dtype=torch.bfloat16,
)
model = PeftModel.from_pretrained(base, ADAPTER)


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[Message]
    max_tokens: int = 400
    temperature: float = 0.5


@app.get("/health")
def health():
    return {"ok": True, "model": "sahbi-darija"}


@app.post("/v1/chat/completions")
def chat(req: ChatRequest):
    if not req.messages:
        raise HTTPException(400, "messages required")

    messages = [m.model_dump() for m in req.messages]
    messages.insert(
        0,
        {
            "role": "system",
            "content": (
                "نتا Sahbi، مساعد مغربي. جاوب بالدارجة المغربية الطبيعية وبنفس script ديال المستخدم "
                "(عربية ولا Arabizi). ما تخلطش الفرنسية بلا سبب."
            ),
        },
    )

    prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    with torch.no_grad():
        out = model.generate(
            **inputs,
            max_new_tokens=min(req.max_tokens, 1200),
            temperature=req.temperature,
            top_p=0.9,
            do_sample=req.temperature > 0,
        )

    text = tokenizer.decode(out[0][inputs.input_ids.shape[-1]:], skip_special_tokens=True).strip()
    return {
        "id": "sahbi-darija",
        "object": "chat.completion",
        "model": "sahbi-darija-8b",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
    }
