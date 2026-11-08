#!/usr/bin/env python3
"""Real font bytes through Android provider + pinned Studio Canvas2D/CanvasKit (Chromium).

Requires a prepared, patched Studio source with npm dependencies and matching pkg WASM.
Does not modify that source. Uses installed redistributable test fonts, never user documents.
"""
import argparse
import hashlib
import json
import pathlib
import socket
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--studio-root', required=True)
parser.add_argument('--regular', default='/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf')
parser.add_argument('--bold', default='/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf')
parser.add_argument('--otf', default='/usr/share/fonts/opentype/urw-base35/NimbusSans-Regular.otf')
parser.add_argument('--korean', default=str(pathlib.Path(__file__).resolve().parent.parent / 'app/src/main/assets/fonts/NotoSansKR-Regular.ttf'))
args = parser.parse_args()
studio = pathlib.Path(args.studio_root).resolve()
provider_source = (pathlib.Path(__file__).resolve().parent.parent / 'app/src/main/assets/android-fonts.mjs').read_text()
fixtures = []
for family, style, weight, filename in [('Liberation Sans', 'Regular', 400, args.regular),
                                       ('Liberation Sans', 'Bold', 700, args.bold),
                                       ('Nimbus Sans', 'Regular', 400, args.otf),
                                       ('Noto Sans KR', 'Regular', 400, args.korean)]:
    data = pathlib.Path(filename).read_bytes()
    fixtures.append({'id': hashlib.sha256(data).hexdigest(), 'family': family,
                     'fullName': family + ' ' + style, 'postscriptName': family.replace(' ', '') + '-' + style,
                     'style': style, 'weight': weight, 'slant': 'normal', 'aliases': [family], 'data': data})
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
url = f'http://127.0.0.1:{port}'
# A test-only Vite configuration avoids the app's optional platform plugin dependency scan.
vite = (studio / 'node_modules/vite/dist/node/index.js').as_uri()
cache_dir = tempfile.TemporaryDirectory(prefix='hwp-font-vite-')
server_script = f"""
import {{createServer}} from {json.dumps(vite)};
const root={json.dumps(str(studio))};
const server=await createServer({{configFile:false,root,cacheDir:{json.dumps(cache_dir.name)},
 define:{{__APP_VERSION__:'"test"',__RHWP_DISABLE_EXTERNAL_WEBFONTS__:'true',__RHWP_HWPCTRL__:'false'}},
 resolve:{{alias:{{'@':root+'/src','@wasm':root+'/../pkg'}}}},
 optimizeDeps:{{noDiscovery:true,entries:[],include:['canvaskit-wasm']}},
 server:{{host:'127.0.0.1',port:{port},strictPort:true,fs:{{allow:[root,root+'/../pkg']}}}}}});
await server.listen();
"""
with cache_dir, tempfile.TemporaryFile(mode='w+') as log:
    process = subprocess.Popen(['node', '--input-type=module', '-e', server_script], stdout=log, stderr=log)
    try:
        deadline = time.monotonic() + 40
        while True:
            try:
                with urllib.request.urlopen(url + '/src/core/local-fonts.ts', timeout=2) as response:
                    if response.status == 200:
                        break
            except Exception:
                if process.poll() is not None or time.monotonic() > deadline:
                    log.seek(0)
                    raise RuntimeError('Test Vite failed: ' + log.read()[-5000:])
                time.sleep(.1)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                                  args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page()
            page.on('requestfailed', lambda request: print('Browser request failed:', request.url, request.failure))
            def handle(route):
                path = route.request.url.split('/__font_test/', 1)[1]
                if path == 'provider.mjs':
                    route.fulfill(content_type='text/javascript', body=provider_source)
                elif path.endswith('.sfnt'):
                    fixture = next(font for font in fixtures if font['id'] + '.sfnt' == path)
                    route.fulfill(content_type='font/ttf', body=fixture['data'])
                else:
                    route.fulfill(content_type='text/html', body='<!doctype html><title>Android font renderer test</title>')
            page.route('**/__font_test/*', handle)
            page.goto(url + '/__font_test/harness.html')
            public_faces = [{key: value for key, value in font.items() if key != 'data'} for font in fixtures]
            result = page.evaluate("""async faces => {
              const {installAndroidFonts} = await import('/__font_test/provider.mjs');
              const local = await import('/src/core/local-fonts.ts');
              const {HostCanvasFontSession, withHostCanvasFonts} = await import('/src/core/host-canvas-fonts.ts');
              const {setRawCanvasFont} = await import('/src/core/canvas-font-raw.ts');
              const {CanvasKitLayerRenderer} = await import('/src/view/canvaskit-renderer.ts');
              const {collectHostFontRequests} = await import('/src/core/host-font-requests.ts');
              const {WasmBridge} = await import('/src/core/wasm-bridge.ts');
              const bridge = new WasmBridge(); await bridge.initialize();
              const session = new HostCanvasFontSession();
              const renderer = await CanvasKitLayerRenderer.create('default', 'software');
              const off = local.onHostFontsChanged(() => renderer.resetDocumentResources());
              const canvas = document.createElement('canvas'); canvas.width = 340; canvas.height = 100;
              const context = canvas.getContext('2d');
              const ckCanvas = document.createElement('canvas'); ckCanvas.width = 340; ckCanvas.height = 100;
              const token = '01234567-1234-1234-1234-0123456789ab';
              let epoch = 1, available = faces, selected = faces[0], reads = 0, releases = 0;
              const request = async (op, args) => {
                if (op === 'fontList') return {revision: String(epoch).padStart(64,'0'), faces: available};
                if (op === 'fontRead') {reads++; selected = available.find(face => face.id === args.id);
                  if(!selected) throw new Error('unknown face'); return {token,url:'/document/'+token};}
                if (op === 'release') {releases++;return true;}
                throw new Error('unknown native operation');
              };
              const nativeFetch = window.fetch;
              window.fetch = (url, options) => String(url).startsWith('/document/')
                ? nativeFetch('/__font_test/'+selected.id+'.sfnt',options) : nativeFetch(url,options);
              const provider = await installAndroidFonts({fonts:{setProvider:local.setHostFontProvider,getState:local.getHostFontState}}, request);
              const results = [];
              for (const face of faces) {
                const record = local.resolveRendererLocalFont(face.family, {weight:face.weight,slant:'normal'});
                if (!record) throw new Error('Host face not resolved');
                await session.prepare([record]);
                const referenceBytes = await (await nativeFetch('/__font_test/'+face.id+'.sfnt')).arrayBuffer();
                const reference = new FontFace('IndependentReference',referenceBytes,{weight:String(face.weight)});
                await reference.load(); document.fonts.add(reference);
                const sample = face.family === 'Noto Sans KR' ? '가나다 한글 ABC 123' : 'Wim ABC 123';
                const draw = (family, raw) => {
                  context.clearRect(0,0,340,100);
                  const font = `${face.weight} 40px "${family}"`;
                  if(raw) setRawCanvasFont(context,font); else withHostCanvasFonts(session,()=>{context.font=font;});
                  context.fillStyle = '#111'; context.fillText(sample, 10,65);
                  return {pixels:canvas.toDataURL(),width:context.measureText(sample).width,font:context.font};
                };
                const host = draw(face.family,false), expected = draw('IndependentReference',true);
                const tree = {pageWidth:340,pageHeight:100,root:{kind:'leaf',bounds:{x:0,y:0,width:340,height:100},ops:[{
                  type:'textRun',text:sample,bbox:{x:10,y:10,width:320,height:70},baseline:65,rotation:0,
                  style:{fontFamily:face.family,fontSize:40,bold:face.weight===700,color:'#111111'}}]}};
                await renderer.prepareHostFonts(collectHostFontRequests(tree));
                renderer.renderPage(tree,ckCanvas,1);
                const diagnostics = renderer.diagnostics();
                if(diagnostics.lastRenderError || diagnostics.lastUnsupportedOps.length) throw new Error(JSON.stringify(diagnostics));
                results.push({family:face.family,style:face.style,bytes:referenceBytes.byteLength,samePixels:host.pixels===expected.pixels,sameWidth:host.width===expected.width,
                  aliasUsed:host.font.includes('__rhwp_host_face_'),loaded:session.diagnostics().loaded,
                  canvasKitFaces:diagnostics.localTypefaceCount,canvasKitFailures:diagnostics.localTypefaceLoadFailureCount,
                  canvasKitPixels:ckCanvas.toDataURL()});
                document.fonts.delete(reference);
              }
              const distinct = results[0].canvasKitPixels !== results[1].canvasKitPixels;
              for(const result of results) delete result.canvasKitPixels;
              available=[]; epoch++; provider.refresh(); await local.prepareHostFontCatalog();
              const afterDelete = {faces:local.getHostFontState().count,canvas:session.diagnostics().loaded,
                canvasKit:renderer.diagnostics().localTypefaceCount};
              off(); session.reset(); renderer.dispose(); await local.setHostFontProvider(null);
              return {results,distinct,afterDelete,reads,releases};
            }""", public_faces)
            for check in result['results']:
                assert check['samePixels'] and check['sameWidth'] and check['aliasUsed'], check
                assert check['loaded'] >= 1 and check['canvasKitFaces'] >= 1 and check['canvasKitFailures'] == 0, check
            assert result['distinct'], 'Real regular/bold outlines must change CanvasKit pixels'
            assert result['afterDelete'] == {'faces': 0, 'canvas': 0, 'canvasKit': 0}, result
            assert result['reads'] >= 8 and result['reads'] == result['releases'], result
            print(json.dumps(result, indent=2))
            browser.close()
    except Exception:
        log.seek(0)
        print(log.read()[-12000:])
        raise
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
