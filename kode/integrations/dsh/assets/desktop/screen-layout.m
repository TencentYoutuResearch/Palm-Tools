// Read physical camera housing geometry. Built once; users need no compiler.
#import <AppKit/AppKit.h>
int main(void) {
  @autoreleasepool {
    NSMutableArray *rows = [NSMutableArray array];
    for (NSScreen *screen in NSScreen.screens) {
      NSMutableDictionary *row = [@{@"id": screen.deviceDescription[@"NSScreenNumber"]} mutableCopy];
      if (@available(macOS 12.0, *)) {
        NSRect left = screen.auxiliaryTopLeftArea, right = screen.auxiliaryTopRightArea;
        if (screen.safeAreaInsets.top > 0 && !NSIsEmptyRect(left) && !NSIsEmptyRect(right)) {
          row[@"left"] = @(NSMaxX(left) - NSMinX(screen.frame));
          row[@"right"] = @(NSMinX(right) - NSMinX(screen.frame));
          row[@"height"] = @(screen.safeAreaInsets.top);
        }
      }
      [rows addObject:row];
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:rows options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stdout);
  }
}
