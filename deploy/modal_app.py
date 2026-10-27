# Modal: run from the repo root
#   modal secret create xyte OXYLABS_USERNAME=… OXYLABS_PASSWORD=… XYTE_API_KEYS=…
#   modal deploy deploy/modal_app.py
# Modal is Python-first; this builds the repo's Dockerfile (full target: HTTP + browser) and runs
# `xyte serve` as a web server. Modal adds its own Python to the image.
#
# Several apps from this one file, each with its own provider and secret (docs/deploy.md#modal):
#   XYTE_MODAL_APP=xyte-decodo XYTE_PROVIDER=decodo modal deploy deploy/modal_app.py
# Read at deploy time:
#   XYTE_MODAL_APP             the app's name (default "xyte"); also its URL's label
#   XYTE_PROVIDER              the provider `xyte serve` uses (default "oxylabs")
#   XYTE_MODAL_SECRET          the Modal secret with its credentials (default: the app's name)
#   XYTE_MODAL_MIN_CONTAINERS  containers kept warm, against cold starts (default 0)
#   XYTE_MODAL_CONCURRENCY     requests per container (default 8)
import os
import subprocess

import modal

# Baked into the image too: Modal imports this file again inside the container, where the deploy
# shell's environment isn't set, and the values must match there.
config = {
    "XYTE_MODAL_APP": os.environ.get("XYTE_MODAL_APP", "xyte"),
    "XYTE_PROVIDER": os.environ.get("XYTE_PROVIDER", "oxylabs"),
    "XYTE_MODAL_MIN_CONTAINERS": os.environ.get("XYTE_MODAL_MIN_CONTAINERS", "0"),
    "XYTE_MODAL_CONCURRENCY": os.environ.get("XYTE_MODAL_CONCURRENCY", "8"),
}
config["XYTE_MODAL_SECRET"] = os.environ.get("XYTE_MODAL_SECRET", config["XYTE_MODAL_APP"])
concurrency = int(config["XYTE_MODAL_CONCURRENCY"])

image = modal.Image.from_dockerfile("Dockerfile", add_python="3.12").env(
    {"HOST": "0.0.0.0", "PORT": "8080", "XYTE_CONCURRENCY": str(concurrency), **config}
)

app = modal.App(config["XYTE_MODAL_APP"], image=image)


@app.function(
    secrets=[modal.Secret.from_name(config["XYTE_MODAL_SECRET"])],
    memory=2048,
    cpu=2.0,
    timeout=600,
    min_containers=int(config["XYTE_MODAL_MIN_CONTAINERS"]),
)
@modal.concurrent(max_inputs=concurrency)
@modal.web_server(port=8080, startup_timeout=60)
def serve():
    subprocess.Popen(["node", "/app/dist/cli.mjs", "serve"])
