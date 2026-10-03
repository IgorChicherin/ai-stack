"""Local Jev-like decision service.

Wraps Tev1 (Ollama /v1/systemone) and serves it two ways on one port:
  - MCP (streamable HTTP) at /mcp   -> opencode tools: classify, check, score, decide
  - REST at POST /v1/decide, GET /health
"""
import os

import httpx
from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434").rstrip("/")
MODEL = os.environ.get("JEV_MODEL", "tev1:0.8b")
KEEP_ALIVE = os.environ.get("JEV_KEEP_ALIVE", "30m")
# Tev1 context is ~2000 tokens; ~4 chars/token leaves room for the questions.
MAX_STATE_CHARS = int(os.environ.get("JEV_MAX_STATE_CHARS", "5000"))
MAX_QUESTIONS = 64

mcp = FastMCP("jev", host="0.0.0.0", port=int(os.environ.get("PORT", "8765")))


async def _systemone(state: str, questions: dict) -> dict:
    if not questions:
        raise ValueError("no questions")
    if len(questions) > MAX_QUESTIONS:
        raise ValueError(f"at most {MAX_QUESTIONS} questions per call")
    if len(state) > MAX_STATE_CHARS:
        state = state[:MAX_STATE_CHARS]
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            f"{OLLAMA_URL}/v1/systemone",
            json={"model": MODEL, "state": state, "questions": questions, "keep_alive": KEEP_ALIVE},
        )
    if r.status_code != 200:
        raise RuntimeError(f"ollama {r.status_code}: {r.text[:300]}")
    return r.json()


@mcp.tool()
async def classify(text: str, instructions: str, options: dict[str, str]) -> dict:
    """Pick exactly one option for the text. Fast (~50 ms), small model: keep text short.

    options maps option name -> description, e.g.
    {"bug": "reports broken behavior", "feature": "asks for new behavior"}.
    Returns the chosen option, per-option probabilities and confidence.
    """
    out = await _systemone(text, {"q": {"type": "choice", "instructions": instructions, "criteria": options}})
    return out["answers"]["q"]


@mcp.tool()
async def check(text: str, question: str) -> dict:
    """Answer a yes/no question about the text. Returns the probability that the answer is true."""
    out = await _systemone(
        text,
        {"q": {"type": "noul", "instructions": question,
               "criteria": {"true": "Yes.", "false": "No."}}},
    )
    return out["answers"]["q"]


@mcp.tool()
async def score(text: str, instructions: str, levels: list[str]) -> dict:
    """Place the text on a rubric. levels is an ordered list of level descriptions, lowest first."""
    out = await _systemone(text, {"q": {"type": "score", "instructions": instructions, "criteria": levels}})
    return out["answers"]["q"]


@mcp.tool()
async def decide(text: str, questions: dict) -> dict:
    """Raw batch call: up to 64 named questions about one text in a single request.

    questions: {name: {"type": "choice"|"noul"|"score", "instructions": str, "criteria": ...}}
    Returns the answers object keyed by question name.
    """
    return (await _systemone(text, questions))["answers"]


@mcp.custom_route("/health", methods=["GET"])
async def health(_: Request) -> JSONResponse:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{OLLAMA_URL}/api/tags")
        names = [m["name"] for m in r.json().get("models", [])]
    except Exception as e:  # report, never hide
        return JSONResponse({"ok": False, "error": str(e)}, status_code=503)
    ok = any(n == MODEL or n.startswith(MODEL.split(":")[0] + ":") and MODEL in n for n in names) or MODEL in names
    return JSONResponse({"ok": ok, "model": MODEL, "ollama_models": names}, status_code=200 if ok else 503)


@mcp.custom_route("/v1/decide", methods=["POST"])
async def rest_decide(request: Request) -> JSONResponse:
    body = await request.json()
    try:
        out = await _systemone(body.get("state", ""), body.get("questions", {}))
    except (ValueError, RuntimeError) as e:
        return JSONResponse({"error": str(e)}, status_code=400 if isinstance(e, ValueError) else 502)
    return JSONResponse(out)


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
