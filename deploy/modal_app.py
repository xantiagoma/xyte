# Modal: run from the repo root
#   modal secret create xyte OXYLABS_USERNAME=… OXYLABS_PASSWORD=… XYTE_API_KEYS=…
#   modal deploy deploy/modal_app.py
# Modal is Python-first; this builds the repo's Dockerfile (full target: HTTP + browser) and runs
# `xyte serve` as a web server. Modal adds its own Python to the image.
import subprocess

import modal

image = modal.Image.from_dockerfile("Dockerfile", add_python="3.12").env(
    {"HOST": "0.0.0.0", "PORT": "8080", "XYTE_PROVIDER": "oxylabs", "XYTE_CONCURRENCY": "8"}
)

app = modal.App("xyte", image=image)


@app.function(secrets=[modal.Secret.from_name("xyte")], memory=2048, cpu=2.0, timeout=600)
@modal.concurrent(max_inputs=8)
@modal.web_server(port=8080, startup_timeout=60)
def serve():
    subprocess.Popen(["node", "/app/dist/cli.mjs", "serve"])
