"""zaapi_kb_gen — thin CLI ของ Phase 4 generation lifecycle.

Commands: build / validate / publish / rollback — `--mongo-uri` + `--db-name`
required ทั้งคู่; `require_disposable_target` gate ก่อน `MongoClient` เสมอ
(disposable-only — ไม่ default ไป shared/prod)"""
from __future__ import annotations

import argparse
import json


def require_disposable_target(uri: str, db_name: str) -> tuple[str, str]:
    """validate (uri, db_name) pair ในฟังก์ชันเดียว — ห้ามเรียกหลัง MongoClient:
    mongodb:// เท่านั้น + single loopback host + explicit port != 27017 +
    no credentials/query/multi-host/db path; db_name ต้อง match
    ^zaapi_kb_p4_verify_[A-Za-z0-9_-]{8,}$"""
    import re
    from urllib.parse import urlparse
    if not isinstance(uri, str) or not uri.startswith("mongodb://"):
        raise ValueError("mongo uri must be mongodb:// (no mongodb+srv)")
    parsed = urlparse(uri)
    if (parsed.username or parsed.password or parsed.query or parsed.params
            or parsed.fragment or parsed.path not in ("", "/")
            or "," in parsed.netloc or parsed.port is None
            or parsed.hostname not in ("localhost", "127.0.0.1", "::1")
            or parsed.port == 27017):
        raise ValueError("mongo uri must be single loopback host with "
                         "explicit non-27017 port, no creds/query/db-path")
    if (not isinstance(db_name, str)
            or not re.fullmatch(r"zaapi_kb_p4_verify_[A-Za-z0-9_-]{8,}",
                                db_name)):
        raise ValueError("db_name must match zaapi_kb_p4_verify_<8+ chars>")
    return uri, db_name


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command",
                        choices=("build", "validate", "publish", "rollback"))
    parser.add_argument("--mongo-uri", required=True)
    parser.add_argument("--db-name", required=True)
    parser.add_argument("--gid")
    parser.add_argument("--exports-root")
    args = parser.parse_args(argv)

    uri, db_name = require_disposable_target(args.mongo_uri, args.db_name)
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
    import pymongo
    from shopeechat import kb_zaapi_generation as gen
    from shopeechat.kb_zaapi_schema import canonical_json
    db = pymongo.MongoClient(uri)[db_name]

    if args.command == "build":
        out = gen.build_generation(db, gid=args.gid,
                                   exports_root=args.exports_root)
    elif args.command == "publish":
        if not args.gid:
            parser.error("--gid required for publish")
        out = gen.publish(db, args.gid, exports_root=args.exports_root)
    elif args.command == "rollback":
        if not args.gid:
            parser.error("--gid required for rollback")
        out = gen.rollback(db, args.gid, exports_root=args.exports_root)
    else:
        coll = db[gen.GEN_COLL]
        doc = coll.find_one({"_id": f"gen:{args.gid}"})
        if doc is None:
            out = "reject:gen-doc-missing"
        else:
            out = gen.validate_generation(
                gen._exports_dir(args.exports_root, args.gid), doc, db)
    print(canonical_json(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
