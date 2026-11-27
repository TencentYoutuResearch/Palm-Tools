import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';

const _id = '0123456789abcdef0123456789abcdef';

Future<(HttpServer, ApiClient)> _serve(
  Future<void> Function(HttpRequest req) handle,
) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((req) async {
    if (req.uri.path == '/healthz') {
      await req.response.close();
      return;
    }
    await handle(req);
  });
  addTearDown(() => server.close(force: true));
  final api = ApiClient(
    Endpoint(
      serverUrl: 'http://${server.address.host}:${server.port}',
      token: 'test',
      deviceId: 'desktop',
      deviceName: 'Desktop',
    ),
  );
  return (server, api);
}

Future<void> _json(HttpRequest req, int status, Object body) async {
  req.response.statusCode = status;
  req.response.headers.contentType = ContentType.json;
  req.response.write(jsonEncode(body));
  await req.response.close();
}

void main() {
  test('image refs keep only well-formed content ids', () {
    final refs = SessionImageRef.listFrom([
      {'id': _id, 'mime': 'image/jpeg', 'size': 12},
      {'id': '../../etc/passwd', 'mime': 'image/png'},
      {'id': 42},
      'nope',
    ]);
    expect(refs, hasLength(1));
    expect(refs.single.name, 'kode-$_id.jpg');
    expect(refs.single.size, 12);
    expect(SessionImageRef.listFrom(null), isEmpty);
  });

  test('downloads read chunks in order until complete', () async {
    final bytes = List<int>.generate(10, (i) => i);
    final offsets = <String?>[];
    final (_, api) = await _serve((req) async {
      expect(req.uri.path, '/api/v1/images/$_id');
      final offset = int.parse(req.uri.queryParameters['offset']!);
      offsets.add(req.uri.queryParameters['offset']);
      final end = offset + 6 > bytes.length ? bytes.length : offset + 6;
      await _json(req, 200, {
        'id': _id,
        'mime': 'image/webp',
        'size': bytes.length,
        'offset': offset,
        'data': base64Encode(bytes.sublist(offset, end)),
        'complete': end == bytes.length,
      });
    });
    final out = BytesBuilder();
    final sink = _CollectSink(out);
    final mime = await api.downloadImage(_id, sink);
    expect(mime, 'image/webp');
    expect(offsets, ['0', '6']);
    expect(out.toBytes(), bytes);
  });

  test('expired images and old servers fail distinctly', () async {
    final (_, expired) = await _serve(
      (req) => _json(req, 404, {'error': 'not_found', 'detail': 'gone'}),
    );
    await expectLater(
      expired.downloadImage(_id, _CollectSink(BytesBuilder())),
      throwsA(
        isA<ApiException>().having((e) => e.error, 'error', 'not_found'),
      ),
    );
    final (_, old) = await _serve((req) async {
      req.response.statusCode = 404;
      await req.response.close();
    });
    await expectLater(
      old.downloadImage(_id, _CollectSink(BytesBuilder())),
      throwsA(
        isA<ApiException>().having((e) => e.error, 'error', 'unsupported'),
      ),
    );
  });
}

class _CollectSink implements IOSink {
  final BytesBuilder out;
  _CollectSink(this.out);

  @override
  void add(List<int> data) => out.add(data);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
