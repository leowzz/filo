"""Embed crops of the supplied screenshot in an offline layout prototype."""
from pathlib import Path
from PIL import Image
from io import BytesIO
import base64
import json

ROOT = Path(__file__).resolve().parent
SOURCE = Path(r'C:/Users/leo/AppData/Local/Temp/codex-clipboard-dd65bf2a-9b93-4aa9-999a-157d47e094ec.png')
image = Image.open(SOURCE).convert('RGB')
boxes = [(637, 142, 3203, 1853), (182, 1962, 308, 2046),
         (332, 1962, 458, 2046), (509, 1954, 582, 2056),
         (632, 1962, 758, 2046), (782, 1962, 908, 2046),
         (932, 1962, 1058, 2046), (1108, 1954, 1182, 2056),
         (1258, 1954, 1332, 2056), (1382, 1962, 1508, 2046),
         (1532, 1962, 1658, 2046), (1682, 1962, 1808, 2046)]
assets = []
for box in boxes:
    stream = BytesIO()
    image.crop(box).save(stream, format='JPEG', quality=91, optimize=True)
    assets.append('data:image/jpeg;base64,' + base64.b64encode(stream.getvalue()).decode())
template = (ROOT / 'prototype.template.html').read_text(encoding='utf-8')
result = template.replace('__ASSETS__', json.dumps(assets))
target = ROOT.parent / 'photo-review-layouts.html'
target.write_text(result, encoding='utf-8')
print(f'{target} ({target.stat().st_size:,} bytes)')
