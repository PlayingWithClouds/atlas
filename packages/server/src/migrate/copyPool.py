"""Copies one old-layout vector pool into the new `<cache>/<encoder id>/<project id>/` layout.

Only reads the source directory. Rewrites image refs from the old Veil proxy form
(`http://host/api/img?url=<remote>`) to `veil:image:<remote>` so stored vectors keep matching
the migrated items, converts vectors.npz from `model_name` to `encoder_id`, and prints a JSON
summary (including every ref present in the copy) on stdout. Needs numpy only.
"""

import argparse
import json
import os
import re
import sys
from urllib.parse import parse_qs, urlsplit

import numpy as np

SPAN_MARKER = "#t="
PROXY_PATH = re.compile(r"^https?://[^/]+/api/img\?")


def convert_base_ref(ref):
    if not PROXY_PATH.match(ref):
        return ref
    values = parse_qs(urlsplit(ref).query).get("url")
    if not values or not values[0]:
        return ref
    return "veil:image:" + values[0]


def convert_ref(ref):
    ref = str(ref)
    marker = ref.rfind(SPAN_MARKER)
    if marker == -1:
        return convert_base_ref(ref)
    return convert_base_ref(ref[:marker]) + ref[marker:]


def convert_refs(refs):
    converted = [convert_ref(ref) for ref in refs]
    changed = sum(1 for before, after in zip(refs, converted) if str(before) != after)
    return np.array(converted, dtype=object), changed


def read_dim(source, vector_arrays):
    meta_path = os.path.join(source, "meta.json")
    if os.path.exists(meta_path):
        with open(meta_path) as handle:
            meta = json.load(handle)
        if isinstance(meta.get("dim"), int):
            return meta["dim"]
    for vectors in vector_arrays:
        if vectors.ndim == 2:
            return int(vectors.shape[1])
    return 0


def copy_trainset(source, destination):
    path = os.path.join(source, "trainset.npz")
    if not os.path.exists(path):
        return None
    data = np.load(path, allow_pickle=True)
    refs, changed = convert_refs(list(data["refs"]))
    np.savez(os.path.join(destination, "trainset.npz"),
             refs=refs, labels=data["labels"], vectors=data["vectors"])
    return {"refs": [str(ref) for ref in refs], "vectors": data["vectors"], "changed": changed}


def copy_vector_cache(source, destination, encoder_id):
    path = os.path.join(source, "vectors.npz")
    if not os.path.exists(path):
        return None
    data = np.load(path, allow_pickle=True)
    refs, changed = convert_refs(list(data["refs"]))
    np.savez(os.path.join(destination, "vectors.npz"),
             encoder_id=encoder_id, refs=refs, vectors=data["vectors"])
    return {"refs": [str(ref) for ref in refs], "vectors": data["vectors"], "changed": changed}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--encoder-id", required=True)
    arguments = parser.parse_args()

    source = os.path.abspath(arguments.source)
    destination = os.path.abspath(arguments.destination)
    if source == destination:
        sys.exit("source and destination are the same directory")
    os.makedirs(destination, exist_ok=True)

    trainset = copy_trainset(source, destination)
    cache = copy_vector_cache(source, destination, arguments.encoder_id)
    parts = [part for part in (trainset, cache) if part is not None]
    dim = read_dim(source, [part["vectors"] for part in parts])
    with open(os.path.join(destination, "meta.json"), "w") as handle:
        json.dump({"encoder_id": arguments.encoder_id, "dim": dim}, handle)

    refs = sorted({ref for part in parts for ref in part["refs"]})
    print(json.dumps({
        "dim": dim,
        "trainRows": len(trainset["refs"]) if trainset else 0,
        "cacheRows": len(cache["refs"]) if cache else 0,
        "rewrittenRefs": sum(part["changed"] for part in parts),
        "refs": refs,
    }))


main()
