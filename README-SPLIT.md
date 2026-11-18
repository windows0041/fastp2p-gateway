# fastp2p-gateway

The gateway half of fastp2p: the WSS control plane, the rule and account store, the
release mirror and the web console. It was extracted from the fastp2p repository
(`c/gateway`) so the two halves can be versioned and released on their own.

Layout notes for the extraction:

- `common/` holds the code shared with the client (enrollment, config merge, UTF-8
  helpers). The [client repository](https://github.com/windows0041/fastp2p) keeps its own copy in `common/`.
- `client-scripts/` holds `linux-installer.sh` and `fastp2p-service.sh` because the
  gateway embeds them and serves them to nodes. They are copies of the client's
  scripts and must be kept in step with them.
- `scripts/publish-release.py` is the shared publisher; it packages the gateway.
