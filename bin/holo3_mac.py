#!/usr/bin/env python3
"""Long-running Holo3 desktop driver for macOS.

Reads NDJSON commands on stdin, executes them via pyautogui, writes
NDJSON responses on stdout. Stays alive for the lifetime of the
/automation session so we pay the pyautogui import cost (~400 ms on a
typical Mac) ONCE per session instead of once per action.

Protocol:
  stdin  ← {"type":"screenshot"}\n
  stdout → {"ok":true,"data":{...}}\n

Actions:
  {"type":"screenshot"}                                 → { base64_image, width, height }
  {"type":"click_mouse","x":N,"y":N,"button":"left"}    → { ok }     # logical pixels
  {"type":"move_mouse","x":N,"y":N}                     → { ok }
  {"type":"scroll","direction":"up|down","amount":N}    → { ok }
  {"type":"type","text":"..."}                          → { ok }
  {"type":"press_keys","keys":"cmd+space"}              → { ok }
  {"type":"wait","ms":N}                                → { ok }

Screenshots are scaled to ~1280 wide before encoding — Holo3's coords
are normalized [0,1000] over whatever image it sees, so the model
doesn't care about the absolute pixel count, and a smaller image cuts
both upload bandwidth and the model's vision-encoder cost.

Safety: pyautogui.FAILSAFE stays ON. Slam the mouse into the top-left
corner of the screen to abort.
"""

import base64
import io
import json
import sys
import time

import pyautogui

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0

TARGET_IMAGE_WIDTH = 1280
JPEG_QUALITY = 60

KEY_ALIASES = {
    "ctrl": "ctrl", "control": "ctrl",
    "cmd": "command", "command": "command", "super": "command", "win": "command",
    "alt": "alt", "option": "alt", "opt": "alt",
    "shift": "shift",
    "enter": "enter", "return": "enter",
    "esc": "escape", "escape": "escape",
    "tab": "tab", "space": "space", "backspace": "backspace", "delete": "delete",
    "up": "up", "down": "down", "left": "left", "right": "right",
}

def parse_keys(raw):
    parts = [p.strip() for p in raw.replace(",", "+").split("+") if p.strip()]
    return [KEY_ALIASES.get(p.lower(), p) for p in parts]

def do_screenshot():
    img = pyautogui.screenshot()
    logical = pyautogui.size()
    target_w = min(TARGET_IMAGE_WIDTH, logical.width)
    target_h = max(1, int(round(target_w * logical.height / logical.width)))
    if img.size != (target_w, target_h):
        img = img.resize((target_w, target_h))
    if img.mode != "RGB":
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    return {
        "base64_image": base64.b64encode(buf.getvalue()).decode("ascii"),
        # Logical screen dims — what pyautogui.click() expects, and what
        # we send to Holo3 as `screen_width/height` so its [0,1000]
        # coordinates re-project to real click positions.
        "width": logical.width,
        "height": logical.height,
        "image_width": target_w,
        "image_height": target_h,
    }

def do_action(action):
    t = action.get("type")
    if t == "screenshot":
        return do_screenshot()
    if t == "click_mouse":
        x = int(action["x"]); y = int(action["y"])
        btn = action.get("button", "left")
        clicks = int(action.get("num_of_clicks") or 1)
        pyautogui.click(x=x, y=y, clicks=clicks, button=btn, _pause=False)
        return {"ok": True, "output": f"click {btn} ({x},{y})"}
    if t == "move_mouse":
        pyautogui.moveTo(int(action["x"]), int(action["y"]), _pause=False)
        return {"ok": True, "output": f"move ({action['x']},{action['y']})"}
    if t == "scroll":
        amt = int(action.get("amount") or 200)
        direction = action.get("direction", "down")
        if direction == "up": pyautogui.scroll(amt)
        elif direction == "down": pyautogui.scroll(-amt)
        elif direction == "left": pyautogui.hscroll(-amt)
        elif direction == "right": pyautogui.hscroll(amt)
        return {"ok": True, "output": f"scroll {direction} {amt}"}
    if t == "type":
        text = str(action.get("text", ""))
        try:
            pyautogui.write(text, interval=0.005, _pause=False)
        except Exception:
            import subprocess
            subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True)
            pyautogui.hotkey("command", "v", interval=0.02, _pause=False)
        return {"ok": True, "output": f"typed {json.dumps(text[:60])}"}
    if t == "press_keys":
        keys = action.get("keys", "")
        if isinstance(keys, list):
            keys = "+".join(keys)
        parsed = parse_keys(keys)
        if not parsed:
            raise ValueError("press_keys: empty")
        if len(parsed) == 1:
            pyautogui.press(parsed[0], _pause=False)
        else:
            pyautogui.hotkey(*parsed, interval=0.02, _pause=False)
        return {"ok": True, "output": f"keys {'+'.join(parsed)}"}
    if t == "wait":
        ms = max(0, min(15000, int(action.get("ms") or 500)))
        time.sleep(ms / 1000.0)
        return {"ok": True, "output": f"wait {ms}ms"}
    if t == "ping":
        return {"ok": True, "output": "pong"}
    raise ValueError(f"unknown action type: {t}")

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def main():
    # Announce readiness — the Node side waits for this line before it
    # accepts the launch request, so we don't dispatch the first action
    # until pyautogui has actually finished importing.
    emit({"ok": True, "event": "ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            action = json.loads(line)
            data = do_action(action)
            emit({"ok": True, "data": data})
        except pyautogui.FailSafeException:
            emit({
                "ok": False,
                "error": "failsafe_triggered",
                "hint": "Mouse hit top-left corner — pyautogui aborted. Move cursor away.",
            })
        except Exception as e:
            emit({"ok": False, "error": f"{type(e).__name__}: {e}"})

if __name__ == "__main__":
    main()
