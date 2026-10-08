"""Encoder whose embed blocks, to exercise call timeouts and concurrency."""

import time

from atlas_ml.testing import FakeEncoder


class SlowEncoder(FakeEncoder):
    id = "slow"

    def embed(self, items):
        time.sleep(2.0)
        return super().embed(items)


def create_encoder(device):
    return SlowEncoder()
