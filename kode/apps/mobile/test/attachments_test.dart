import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/protocol/attachments.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';

void main() {
  test('attachment references round-trip through a message', () {
    const photo = '/var/folders/x/T/kode-attachments/u-1/IMG_1.jpg';
    const zip =
        r'C:\Users\Jo Doe\AppData\Local\Temp\kode-attachments\u-2\src.zip';
    final message = composeAttachmentMessage('  look at these  ', [photo, zip]);
    expect(
      message,
      'look at these\n\nAttached file: $photo\nAttached file: $zip',
    );
    final split = splitAttachmentMessage(message);
    expect(split.text, 'look at these');
    expect(split.attachments.map((a) => a.path), [photo, zip]);
    expect(split.attachments.map((a) => a.kind), [
      AttachmentKind.image,
      AttachmentKind.archive,
    ]);
    expect(split.attachments.last.name, 'src.zip');

    final only = splitAttachmentMessage(composeAttachmentMessage('', [photo]));
    expect(only.text, isEmpty);
    expect(only.attachments.single.name, 'IMG_1.jpg');

    // Text that merely mentions the prefix is left alone.
    const plain = 'Attached file: see notes.txt';
    expect(splitAttachmentMessage(plain).text, plain);
    expect(splitAttachmentMessage(plain).attachments, isEmpty);
  });

  test('uploads send ordered chunks and return the desktop path', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final chunks = <Map<String, dynamic>>[];
    final received = <int>[];
    server.listen((req) async {
      if (req.uri.path == '/healthz') {
        await req.response.close();
        return;
      }
      expect(req.uri.path, '/api/v1/attachments');
      final body =
          jsonDecode(await utf8.decoder.bind(req).join())
              as Map<String, dynamic>;
      chunks.add(body);
      received.addAll(base64Decode(body['data'] as String));
      req.response.headers.contentType = ContentType.json;
      final done = received.length == body['size'];
      req.response.write(
        jsonEncode({
          'received': received.length,
          if (done) 'complete': true,
          if (done) 'path': '/tmp/kode-attachments/${body['upload_id']}/a.bin',
        }),
      );
      await req.response.close();
    });
    addTearDown(() => server.close(force: true));

    final dir = await Directory.systemTemp.createTemp('kode-attach-test');
    addTearDown(() => dir.delete(recursive: true));
    final file = File('${dir.path}/a.bin');
    final bytes = List<int>.generate(attachmentChunkBytes + 10, (i) => i % 251);
    await file.writeAsBytes(bytes);

    final api = ApiClient(
      Endpoint(
        serverUrl: 'http://${server.address.host}:${server.port}',
        token: 'test',
        deviceId: 'desktop',
        deviceName: 'Desktop',
      ),
    );
    final progress = <double>[];
    final path = await api.uploadAttachment(
      file,
      name: 'a.bin',
      onProgress: progress.add,
    );

    expect(chunks, hasLength(2));
    expect(chunks.map((c) => c['offset']), [0, attachmentChunkBytes]);
    expect(chunks.map((c) => c['upload_id']).toSet(), hasLength(1));
    expect(received, bytes);
    expect(progress.last, 1.0);
    expect(path, '/tmp/kode-attachments/${chunks.first['upload_id']}/a.bin');
  });

  test('oversized files are rejected before any request', () async {
    final dir = await Directory.systemTemp.createTemp('kode-attach-test');
    addTearDown(() => dir.delete(recursive: true));
    final file = File('${dir.path}/big.mov');
    final raf = await file.open(mode: FileMode.write);
    await raf.truncate(maxAttachmentBytes + 1);
    await raf.close();
    final api = ApiClient(
      Endpoint(
        serverUrl: 'http://127.0.0.1:9',
        token: 'test',
        deviceId: 'desktop',
        deviceName: 'Desktop',
      ),
    );
    await expectLater(
      api.uploadAttachment(file, name: 'big.mov'),
      throwsA(isA<ApiException>().having((e) => e.status, 'status', 413)),
    );
  });
}
