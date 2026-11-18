#!/usr/bin/env python3
"""Embed the installer templates in the gateway."""
import json
import sys
from pathlib import Path

linux, service, macos, output_path = sys.argv[1:]
scripts = {'linux_install_script': linux, 'linux_service_script': service, 'macos_install_script': macos}
with Path(output_path).open('w', encoding='utf-8') as output:
    for name, path in scripts.items():
        script = Path(path).read_text(encoding='utf-8')
        output.write(f'static const char {name}[] = {json.dumps(script, ensure_ascii=False)};\n')
