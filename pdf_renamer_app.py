# file: pdf_renamer_app.py
# fmt: off (≤ 80-char lines)

import os
import pathlib
import time
from typing import TypedDict

import rumps
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

from pdf2image import convert_from_path
from ocrmac import ocrmac
from pdfminer.high_level import extract_text
import openai
from dotenv import load_dotenv

from langgraph.graph import StateGraph

# Disable charset normalization for mypyc
os.environ.setdefault("CHARSET_NORMALIZER_DISABLE_MYPYC", "1")

# ---------- state -----------------------------------------------------------

class State(TypedDict):
    path: pathlib.Path
    raw_text: str | None
    meta: dict | None

# ---------- config ----------------------------------------------------------

load_dotenv()

WATCH_FOLDER = pathlib.Path(
    os.getenv("WATCH_FOLDER", pathlib.Path.home() / "Desktop" / "pdfs")
).expanduser()

LLM_MODEL = os.getenv("LLM_MODEL", "gpt-3.5-turbo")
openai.api_key = os.getenv("OPENAI_API_KEY")

DATE_FORMAT = "%Y-%m-%d"

# ---------- OCR helper ------------------------------------------------------

def ocr_pdf(path: pathlib.Path, dpi: int = 300) -> str:
    """
    Render each page to a PIL Image and let Apple's Vision OCR it.
    """
    images = convert_from_path(str(path), dpi=dpi)
    text_results = [ocrmac.text_from_image(img) for img in images]
    # Extract just the text from each tuple (text, confidence, bbox)
    texts = []
    for page_results in text_results:
        page_text = " ".join([result[0] for result in page_results])
        texts.append(page_text)
    return "\n\n".join(texts)

# ---------- LangGraph nodes -------------------------------------------------

def parse_pdf(state: State) -> dict[str, str]:
    """
    Fast path: pdfminer
    Fallback: Vision OCR via ocrmac
    """
    text = extract_text(state["path"]) or ""
    if len(text.strip()) < 20:   # heuristic: probably scanned
        text = ocr_pdf(state["path"])
    return {"raw_text": text}

def call_llm(state: State) -> dict[str, dict]:
    """Add 'meta' (date, title, addressee) to state."""
    raw_text = state["raw_text"] or ""
    system = (
        "You are a parser that extracts three fields from documents:\n"
        "- date (yyyy-mm-dd; today if absent)\n"
        "- title (<= 8 words, no commas)\n"
        "- addressee (first name only; blank if unknown)\n"
        'Return JSON exactly like '
        '{"date":"...", "title":"...", "addressee":"..."}'
    )
    user = f"Document text follows ```\n{raw_text[:12_000]}\n```"
    rsp = openai.chat.completions.create(
        model=LLM_MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0,
    )
    content = rsp.choices[0].message.content
    if content is None:
        raise ValueError("No content returned from LLM")
    meta = eval(content.strip())
    return {"meta": meta}

def rename_file(state: State) -> dict:
    """Rename file on disk; no further state changes."""
    path = state["path"]
    meta = state["meta"] or {}
    date = meta.get("date") or time.strftime(DATE_FORMAT)
    title = (meta.get("title") or "Untitled").strip()
    addressee = (meta.get("addressee") or "Unknown").strip()
    new_name = f"{date} {title} [{addressee}].pdf"
    new_path = path.with_name(new_name)
    path.rename(new_path)
    rumps.notification(
        "PDF renamed",
        subtitle=new_name,
        message=str(new_path),
    )
    return {}            # nothing new to add to state

# ---------- graph wiring ----------------------------------------------------

graph = StateGraph(State)

graph.add_node("parse", parse_pdf)
graph.add_node("llm", call_llm)
graph.add_node("rename", rename_file)

graph.set_entry_point("parse")
graph.add_edge("parse", "llm")
graph.add_edge("llm", "rename")

pipeline = graph.compile()

# ---------- watchdog handler ------------------------------------------------

class PDFHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory:
            return
        path = pathlib.Path(str(event.src_path))
        if path.suffix.lower() != ".pdf":
            return
        # wait until file closed by the writer
        for _ in range(10):
            try:
                path.open("rb").close()
                break
            except PermissionError:
                time.sleep(0.5)
        pipeline.invoke({"path": path, "raw_text": None, "meta": None})

# ---------- rumps menubar app ----------------------------------------------

class PDFRenamerApp(rumps.App):
    def __init__(self):
        super().__init__("PDF-AI")
        self.menu = ["Open folder", "Quit"]
        self.observer = Observer()
        self.handler = PDFHandler()
        self.observer.schedule(
            self.handler, str(WATCH_FOLDER), recursive=False
        )
        self.observer.start()

    @rumps.clicked("Open folder")
    def open_folder(_):
        os.system(f'open "{WATCH_FOLDER}"')

    @rumps.clicked("Quit")
    def quit_(self, _):
        self.observer.stop()
        self.observer.join()
        rumps.quit_application()

# ---------- CLI entry -------------------------------------------------------

if __name__ == "__main__":
    print(f"Watching {WATCH_FOLDER} for .pdf files …")
    PDFRenamerApp().run()