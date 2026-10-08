"""Logging helper. stdout carries the JSON-RPC stream, so everything goes to stderr."""

import sys


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)
