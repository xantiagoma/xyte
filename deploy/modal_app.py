# Modal: run from the repo root
#   modal secret create xyte OXYLABS_USERNAME=… OXYLABS_PASSWORD=… XYTE_API_KEYS=…
#   modal deploy deploy/modal_app.py
# Modal is Python-first; this builds the repo's Dockerfile (full target: HTTP + browser) and runs
# `xyte serve` as a web server. Modal adds its own Python to the image.
#
# Several apps from this one file, each with its own provider and secret (docs/deploy.md#modal):
#   XYTE_MODAL_APP=xyte-decodo XYTE_PROVIDER=decodo modal deploy deploy/modal_app.py
# Read at deploy time (defaults in brackets):
#   XYTE_MODAL_APP               the app's name, and so its URL [xyte]
#   XYTE_PROVIDER                the provider `xyte serve` uses [oxylabs]
#   XYTE_MODAL_SECRET            the Modal secret with its credentials [the app's name]
#   XYTE_MODAL_MIN_CONTAINERS    containers kept warm while idle, against cold starts [0]
#   XYTE_MODAL_MAX_CONTAINERS    the cap: max × concurrency should fit the provider's limit [10]
#   XYTE_MODAL_BUFFER_CONTAINERS idle containers kept ready while traffic flows, for bursts [0]
#   XYTE_MODAL_SCALEDOWN         seconds an idle container lives (2–1200) [300]
#   XYTE_MODAL_CONCURRENCY       requests a container takes at most (max_inputs) [8]
#   XYTE_MODAL_TARGET_INPUTS     what the autoscaler aims for; above it is burst room [3/4 of max]
#   XYTE_MODAL_MEMORY / _CPU     per container, in MiB / cores [2048 / 2]
#   XYTE_MODAL_REGION            e.g. "us" or "eu" (Modal bills 1.15× for a broad region) [any]
#   XYTE_TIMEOUT / XYTE_RETRIES  per attempt, and retries: their product must stay under
#                                Modal's 150 s per web request [30 / 3]
import os
import subprocess

import modal


def setting(name: str, default: str) -> str:
    return os.environ.get(name, default)


# Baked into the image too: Modal imports this file again inside the container, where the deploy
# shell's environment isn't set, and the values must match there.
config = {
    "XYTE_MODAL_APP": setting("XYTE_MODAL_APP", "xyte"),
    "XYTE_PROVIDER": setting("XYTE_PROVIDER", "oxylabs"),
    "XYTE_MODAL_MIN_CONTAINERS": setting("XYTE_MODAL_MIN_CONTAINERS", "0"),
    "XYTE_MODAL_MAX_CONTAINERS": setting("XYTE_MODAL_MAX_CONTAINERS", "10"),
    "XYTE_MODAL_BUFFER_CONTAINERS": setting("XYTE_MODAL_BUFFER_CONTAINERS", "0"),
    "XYTE_MODAL_SCALEDOWN": setting("XYTE_MODAL_SCALEDOWN", "300"),
    "XYTE_MODAL_CONCURRENCY": setting("XYTE_MODAL_CONCURRENCY", "8"),
    "XYTE_MODAL_MEMORY": setting("XYTE_MODAL_MEMORY", "2048"),
    "XYTE_MODAL_CPU": setting("XYTE_MODAL_CPU", "2"),
    "XYTE_MODAL_REGION": setting("XYTE_MODAL_REGION", ""),
    "XYTE_TIMEOUT": setting("XYTE_TIMEOUT", "30"),
    "XYTE_RETRIES": setting("XYTE_RETRIES", "3"),
}
config["XYTE_MODAL_SECRET"] = setting("XYTE_MODAL_SECRET", config["XYTE_MODAL_APP"])
max_inputs = int(config["XYTE_MODAL_CONCURRENCY"])
config["XYTE_MODAL_TARGET_INPUTS"] = setting("XYTE_MODAL_TARGET_INPUTS", str(max(1, max_inputs * 3 // 4)))

worst = int(config["XYTE_TIMEOUT"]) * (int(config["XYTE_RETRIES"]) + 1)
if worst >= 150:
    print(f"warning: XYTE_TIMEOUT × attempts is {worst}s; Modal answers a web request past 150 s with a 303 redirect")

image = modal.Image.from_dockerfile("Dockerfile", add_python="3.12").env(
    # xyte's own queue matches Modal's: requests past max_inputs go to another container.
    {"HOST": "0.0.0.0", "PORT": "8080", "XYTE_CONCURRENCY": str(max_inputs), **config}
)

app = modal.App(config["XYTE_MODAL_APP"], image=image)


@app.function(
    secrets=[modal.Secret.from_name(config["XYTE_MODAL_SECRET"])],
    memory=int(config["XYTE_MODAL_MEMORY"]),
    cpu=float(config["XYTE_MODAL_CPU"]),
    timeout=600,
    min_containers=int(config["XYTE_MODAL_MIN_CONTAINERS"]),
    max_containers=int(config["XYTE_MODAL_MAX_CONTAINERS"]),
    buffer_containers=int(config["XYTE_MODAL_BUFFER_CONTAINERS"]) or None,
    scaledown_window=int(config["XYTE_MODAL_SCALEDOWN"]),
    region=config["XYTE_MODAL_REGION"] or None,
)
@modal.concurrent(max_inputs=max_inputs, target_inputs=int(config["XYTE_MODAL_TARGET_INPUTS"]))
@modal.web_server(port=8080, startup_timeout=60)
def serve():
    subprocess.Popen(["node", "/app/dist/cli.mjs", "serve"])
