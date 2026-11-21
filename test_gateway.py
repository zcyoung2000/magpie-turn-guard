import json, re, sys, urllib.request

config = sys.argv[1]           # path to codex config.toml
base = sys.argv[2]             # gateway base url
codeword = sys.argv[3]         # codeword to plant
toml = open(config).read()
token = re.search(r'\[model_providers\.magpie\][^\[]*?experimental_bearer_token\s*=\s*"([^"]+)"', toml, re.S).group(1)

def msg(role, text):
    return {"type": "message", "role": role, "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}]}

inp = [msg("user", "<environment_context>\ncwd: /tmp\n</environment_context>"),
       msg("user", f"Remember this codeword: {codeword}. Just acknowledge."), msg("assistant", "Acknowledged.")]
for i in range(2, 11):
    inp.append(msg("user", f"Filler turn {i}: say ok.")); inp.append(msg("assistant", "ok"))
inp.append(msg("user", "What was the codeword I gave you in my first real message? Reply with just the codeword."))
req = urllib.request.Request(
    base + "/responses",
    data=json.dumps({"model": "xingchi/gpt-6.1-sol", "input": inp, "stream": False}).encode(),
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + token,
             "x-openai-actor-authorization": "magpie"}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.loads(r.read())
    text = data.get("output_text") or ""
    if not text:
        for it in data.get("output", []):
            for p in it.get("content", []):
                if p.get("type") == "output_text": text += p.get("text", "")
    print("HTTP 200, reply:", text.strip()[:80])
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:200])
