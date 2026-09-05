#!/usr/bin/env python3
"""Install and apply the secret-free ETAS-003 oMLX model profile."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


MODEL_ID = "Qwen3.5-9B-MLX-4bit"
PROFILE_NAME = "nomo-etas003"
PROFILE_SETTINGS = {
    "max_tokens": 256,
    "preserve_thinking": False,
    "temperature": 0.0,
}
REMOVED_PROFILE_SETTINGS = (
    "chat_template_kwargs",
    "enable_thinking",
    "forced_ct_kwargs",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--resources",
        default="/Applications/oMLX.app/Contents/Resources",
        help="directory containing the installed omlx Python package",
    )
    parser.add_argument("--base-path", default=str(Path.home() / ".omlx"))
    args = parser.parse_args()

    resources = str(Path(args.resources).resolve())
    if resources not in sys.path:
        sys.path.insert(0, resources)
    from omlx.model_settings import ModelSettingsManager

    manager = ModelSettingsManager(Path(args.base_path))
    existing = manager.get_profile(MODEL_ID, PROFILE_NAME)
    if existing is None:
        manager.save_profile(
            MODEL_ID,
            PROFILE_NAME,
            "Nomo ETAS-003",
            "Nomo ETAS-003 integration profile; thinking control comes from Etas.",
            PROFILE_SETTINGS,
            expose_as_model=False,
            api_name=PROFILE_NAME,
        )
    else:
        manager.update_profile(
            MODEL_ID,
            PROFILE_NAME,
            display_name="Nomo ETAS-003",
            description="Nomo ETAS-003 integration profile; thinking control comes from Etas.",
            settings=PROFILE_SETTINGS,
            expose_as_model=False,
            api_name=PROFILE_NAME,
        )
    applied = manager.apply_profile(MODEL_ID, PROFILE_NAME)
    if applied is None:
        raise RuntimeError("failed to apply the ETAS-003 oMLX profile")

    effective = applied.to_dict()
    for key, expected in PROFILE_SETTINGS.items():
        if effective.get(key) != expected:
            raise RuntimeError(f"effective profile mismatch for {key}")
    for key in REMOVED_PROFILE_SETTINGS:
        if key in effective:
            raise RuntimeError(f"obsolete forced profile setting remains: {key}")
    canonical = json.dumps(
        {
            "model": MODEL_ID,
            "profile": PROFILE_NAME,
            "settings": PROFILE_SETTINGS,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    print(canonical)
    print(f"profile_sha256={hashlib.sha256(canonical.encode()).hexdigest()}")


if __name__ == "__main__":
    main()
