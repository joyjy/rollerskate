#!/usr/bin/env python3

import os
from pathlib import Path
import re
import subprocess

import yaml


DATA_DIR = Path("/data")
HOMESERVER_CONFIG = DATA_DIR / "homeserver.yaml"
APPLICATION_SERVICE_CONFIG = DATA_DIR / "rollerskate-application-service.yaml"


def require_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def require_secret(name: str) -> str:
    file_name = os.environ.get(f"{name}_FILE", "").strip()
    if file_name:
        value = Path(file_name).read_text(encoding="utf-8").strip()
        if not value:
            raise RuntimeError(f"{name}_FILE is empty")
        return value
    return require_environment(name)


def generate_homeserver_config() -> None:
    if HOMESERVER_CONFIG.exists():
        return
    subprocess.run(["/start.py", "generate"], check=True)


def write_application_service_config() -> None:
    server_name = require_environment("SYNAPSE_SERVER_NAME")
    escaped_server_name = re.escape(server_name)
    config = {
        "id": "rollerskate",
        "url": require_environment("ROLLERSKATE_APPLICATION_SERVICE_URL"),
        "as_token": require_secret("ROLLERSKATE_MATRIX_AS_TOKEN"),
        "hs_token": require_secret("ROLLERSKATE_MATRIX_HS_TOKEN"),
        "sender_localpart": "rollerskate",
        "rate_limited": False,
        "namespaces": {
            "users": [
                {
                    "exclusive": True,
                    "regex": rf"^@rs_h_[0-9a-f]{{32}}:{escaped_server_name}$",
                },
                {
                    "exclusive": True,
                    "regex": rf"^@rs_a_[0-9a-f]{{32}}:{escaped_server_name}$",
                },
            ],
            "aliases": [],
            "rooms": [],
        },
    }
    APPLICATION_SERVICE_CONFIG.write_text(
        yaml.safe_dump(config, sort_keys=False), encoding="utf-8"
    )


def register_application_service() -> None:
    config = yaml.safe_load(HOMESERVER_CONFIG.read_text(encoding="utf-8"))
    config["app_service_config_files"] = [str(APPLICATION_SERVICE_CONFIG)]
    HOMESERVER_CONFIG.write_text(
        yaml.safe_dump(config, sort_keys=False), encoding="utf-8"
    )


def main() -> None:
    generate_homeserver_config()
    write_application_service_config()
    register_application_service()
    os.execv("/start.py", ["/start.py"])


if __name__ == "__main__":
    main()
