"""Compact copies of real device screenshots for inspection through CI logs.

Original, full-resolution PNGs remain in the artifact. No generated UI images.
"""
import base64, io, json, os
from pathlib import Path
from PIL import Image

api=os.environ['ANDROID_API']
for folder,names in [(Path('.qa/android-system-'+api),['1.png','4.png']),
                     (Path('.qa/android-'+api),['failure.png','17.png','28.png']),
                     (Path('.qa/android-termux-'+api),['failure.png','2.png','6.png'])]:
    for name in names:
        source=folder/name
        if not source.exists():continue
        with Image.open(source) as im:
            im=im.convert('RGB');im.thumbnail((1000,700));out=io.BytesIO();im.save(out,format='JPEG',quality=65)
        print('EVIDENCE_IMAGE '+json.dumps({'path':str(source),'jpeg':base64.b64encode(out.getvalue()).decode()}),flush=True)
