/// Phone attachments: limits shared with `kode-relay-protocol` and the text
/// form a message uses to reference uploaded files.
///
/// The desktop writes each upload to `<temp>/kode-attachments/<id>/<name>`
/// and the message carries that absolute path, one line per file, so the CLI
/// can read it and the transcript can show it again later.
library;

/// Mirrors `MAX_ATTACHMENT_BYTES`.
const maxAttachmentBytes = 50 * 1024 * 1024;

/// Mirrors `MAX_ATTACHMENT_CHUNK_BYTES`.
const attachmentChunkBytes = 2 * 1024 * 1024;

/// Files one message may carry.
const maxAttachmentsPerMessage = 6;

const _referencePrefix = 'Attached file: ';
final _referenceLine = RegExp(
  r'^Attached file: (.+kode-attachments[\\/][^\\/]+[\\/][^\\/]+)$',
);

enum AttachmentKind { image, video, archive, file }

AttachmentKind attachmentKindOf(String name) {
  final dot = name.lastIndexOf('.');
  final ext = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  return switch (ext) {
    'jpg' ||
    'jpeg' ||
    'png' ||
    'gif' ||
    'webp' ||
    'heic' ||
    'heif' ||
    'bmp' => AttachmentKind.image,
    'mov' ||
    'mp4' ||
    'm4v' ||
    'avi' ||
    'mkv' ||
    'webm' ||
    '3gp' => AttachmentKind.video,
    'zip' || 'tar' || 'gz' || 'tgz' || 'rar' || '7z' => AttachmentKind.archive,
    _ => AttachmentKind.file,
  };
}

String formatAttachmentSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(0)} KB';
  return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
}

/// A desktop path named by a message.
class AttachmentReference {
  final String path;
  const AttachmentReference(this.path);

  String get name => path.split(RegExp(r'[\\/]')).last;
  AttachmentKind get kind => attachmentKindOf(name);
}

/// Appends one reference line per uploaded path after the typed text.
String composeAttachmentMessage(String text, List<String> paths) {
  final body = text.trim();
  if (paths.isEmpty) return body;
  final lines = paths.map((path) => '$_referencePrefix$path').join('\n');
  return body.isEmpty ? lines : '$body\n\n$lines';
}

/// Splits a message into its typed text and attachment references.
({String text, List<AttachmentReference> attachments}) splitAttachmentMessage(
  String message,
) {
  if (!message.contains(_referencePrefix)) {
    return (text: message, attachments: const []);
  }
  final kept = <String>[];
  final refs = <AttachmentReference>[];
  for (final line in message.split('\n')) {
    final match = _referenceLine.firstMatch(line.trimRight());
    if (match != null) {
      refs.add(AttachmentReference(match.group(1)!));
    } else {
      kept.add(line);
    }
  }
  return (text: kept.join('\n').trimRight(), attachments: refs);
}
