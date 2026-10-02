import argparse
import json
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

BASE_MODEL = "Qwen/Qwen3-8B"

DEFAULT_CASES = [
    "Kat hder darija?",
    "Ash katkhreb9 a sahbi 😁",
    "Bghit nkteb message l moul dar bach n9olo lma kaytsrb.",
    "شنو الفرق بين الخدمة الحرة و CDI ففرنسا؟",
    "3tini جواب قصير وبالدارجة لواحد قال ليا مبروك.",
    "Wach t9der t3awni nرتب budget dyali bla ma tخلط الفرنسية بزاف؟",
]


def load(model_path):
    tok = AutoTokenizer.from_pretrained(model_path)
    base = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        device_map="auto",
        torch_dtype=torch.bfloat16,
    )
    model = PeftModel.from_pretrained(base, model_path)
    return tok, model


def generate(tok, model, prompt):
    msgs = [
        {
            "role": "system",
            "content": (
                "نتا Sahbi، مساعد مغربي. جاوب بالدارجة المغربية الطبيعية حسب طريقة كلام المستخدم. "
                "إلا كتب Arabizi جاوب Arabizi بشكل طبيعي، وإلا كتب بالعربية جاوب بالعربية. "
                "ما تخلطش الفرنسية بلا سبب وما تشرحش الكلمات إلا إلى طلب."
            ),
        },
        {"role": "user", "content": prompt},
    ]
    text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    inputs = tok(text, return_tensors="pt").to(model.device)
    with torch.no_grad():
        out = model.generate(
            **inputs,
            max_new_tokens=180,
            temperature=0.6,
            top_p=0.9,
            do_sample=True,
        )
    return tok.decode(out[0][inputs.input_ids.shape[-1]:], skip_special_tokens=True).strip()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--out", default="eval-results.json")
    args = p.parse_args()

    tok, model = load(args.model)
    rows = [{"prompt": q, "answer": generate(tok, model, q)} for q in DEFAULT_CASES]
    Path(args.out).write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    for row in rows:
        print("\nUSER:", row["prompt"])
        print("SAHBI:", row["answer"])


if __name__ == "__main__":
    main()
