"""Tagger module for worker tests: scores depend only on the ref."""


class FakeTagger:
    id = "fake-tagger"
    media_kinds = ["image"]

    def tag(self, items):
        rows = []
        for item in items:
            if item.ref == "broken":
                rows.append({})
                continue
            rows.append({"cat": 0.91234567, "dog": 0.2, "ref_length": len(item.ref) / 100})
        return rows


def create_tagger(device):
    return FakeTagger()
