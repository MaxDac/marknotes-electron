# Note format

The note format, sync manifest, note links and attachments shared by all MarkNotes apps are specified in
[marknotes-spec](https://github.com/MaxDac/marknotes-spec), checked out as the `spec/` submodule:
see [spec/note-format.md](../spec/note-format.md) ([on GitHub](https://github.com/MaxDac/marknotes-spec/blob/main/note-format.md)).

The spec's golden fixtures run against this app with `npm run test:parity`. Change the spec first, then mirror the
change here and in the Android and web apps (see [AGENTS.md](../AGENTS.md)).
