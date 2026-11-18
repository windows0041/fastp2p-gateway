from pathlib import Path
import subprocess


def create_certificates(output, *hosts, wsl=()):
    script = Path(__file__).resolve().parents[1] / 'scripts/tls/generate-cert.sh'

    def linux_path(path):
        if not wsl:
            return str(path)
        return subprocess.check_output([*wsl, 'wslpath', '-a', path.as_posix()],
                                       text=True).strip()

    subprocess.run([*wsl, 'bash', linux_path(script), linux_path(output), *hosts],
                   check=True, stdout=subprocess.DEVNULL)
