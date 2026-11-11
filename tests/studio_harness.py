"""Shared helpers for the real-Studio browser tests that belong to the interaction worker (not the QA-owned studio-ui.py).

Chromium + a recording OfflineNative stub: NOT Android WebView, NOT MainActivity, NOT Samsung DeX. The Studio is the PATCHED source tree
(dev server, no CSP) with the real app/src/main/assets/studio-host.js injected before it, exactly like the production index.html does.
"""
import contextlib
import json
import pathlib
import socket
import subprocess
import tempfile
import time
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent
ASSETS = REPO / 'app/src/main/assets'


@contextlib.contextmanager
def vite_server(studio_root):
    studio = pathlib.Path(studio_root).resolve()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    vite = (studio / 'node_modules/vite/dist/node/index.js').as_uri()
    cache = tempfile.TemporaryDirectory(prefix='hwp-harness-vite-')
    script = f"""
import {{createServer}} from {json.dumps(vite)};
const root={json.dumps(str(studio))};
const stubPlugin={{name:'hwpctrl-stub',resolveId(id){{return id==='@rhwp/hwpctrl/studio-plugin'?'\\0hwpctrl-stub':null}},load(id){{return id==='\\0hwpctrl-stub'?'export const hwpctrlStudioPlugin=null':null}}}};
const server=await createServer({{configFile:false,plugins:[stubPlugin],root,cacheDir:{json.dumps(cache.name)},
 define:{{__APP_VERSION__:'"test"',__RHWP_DISABLE_EXTERNAL_WEBFONTS__:'true',__RHWP_HWPCTRL__:'false',__RHWP_AI__:'false'}},
 resolve:{{alias:{{'@':root+'/src','@wasm':root+'/../pkg'}}}},
 optimizeDeps:{{noDiscovery:true,entries:[],include:['canvaskit-wasm']}},
 server:{{host:'127.0.0.1',port:{port},strictPort:true,fs:{{allow:[root,root+'/../pkg']}}}}}});
await server.listen();
"""
    with tempfile.TemporaryFile(mode='w+') as log:
        process = subprocess.Popen(['node', '--input-type=module', '-e', script], stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 90
            while True:
                try:
                    with urllib.request.urlopen(url + '/index.html', timeout=2):
                        break
                except Exception:
                    if process.poll() is not None or time.monotonic() > deadline:
                        log.seek(0)
                        raise RuntimeError('Studio dev server failed: ' + log.read()[-4000:])
                    time.sleep(.2)
            yield url
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            cache.cleanup()


def host_source():
    return (ASSETS / 'studio-host.js').read_text()


def serve_host_assets(page):
    """The dev server has no /android-fonts.mjs; the host imports it from the app assets in production."""
    def serve(route):
        name = route.request.url.rsplit('/', 1)[1].split('?')[0]
        route.fulfill(content_type='text/javascript', body=(ASSETS / name).read_text())
    page.route('**/android-fonts.mjs', serve)
