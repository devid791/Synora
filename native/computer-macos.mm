#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <iostream>
#include <string>
#include <cmath>

struct ScopedCF { CFTypeRef value; ~ScopedCF() { if (value) CFRelease(value); } };
static bool focusedWindow(pid_t pid, AXUIElementRef app, AXUIElementRef window) {
  if ([NSWorkspace sharedWorkspace].frontmostApplication.processIdentifier != pid) return false;
  CFTypeRef focused = nil;
  bool same = AXUIElementCopyAttributeValue(app,kAXFocusedWindowAttribute,&focused)==kAXErrorSuccess && focused && CFEqual(focused,window);
  if (focused) CFRelease(focused);
  return same;
}
static id attribute(AXUIElementRef element, CFStringRef key) {
  CFTypeRef value=nil;
  if(AXUIElementCopyAttributeValue(element,key,&value)!=kAXErrorSuccess) return nil;
  return CFBridgingRelease(value);
}
static NSString *boundedText(id value, NSUInteger limit) {
  if(![value isKindOfClass:[NSString class]]) return @"";
  return [value substringToIndex:MIN([value length],limit)];
}
// Read the selected window only, without activating it or performing AX
// actions. Bound traversal and IPC time; custom inaccessible UI keeps its image.
static void inspectWindow(AXUIElementRef window, CGRect rect, double width, double height) {
  NSMutableArray *queue=[NSMutableArray arrayWithObject:(__bridge id)window];
  NSMutableArray *items=[NSMutableArray array];
  NSUInteger cursor=0; CFAbsoluteTime deadline=CFAbsoluteTimeGetCurrent()+3;
  while(cursor<queue.count && cursor<300 && items.count<100 && CFAbsoluteTimeGetCurrent()<deadline) {
    AXUIElementRef e=(__bridge AXUIElementRef)queue[cursor++];
    NSString *role=boundedText(attribute(e,kAXRoleAttribute),80);
    NSString *subrole=boundedText(attribute(e,kAXSubroleAttribute),80);
    bool secure=[subrole isEqualToString:@"AXSecureTextField"] || [role rangeOfString:@"secure" options:NSCaseInsensitiveSearch].location!=NSNotFound;
    id positionValue=attribute(e,kAXPositionAttribute),sizeValue=attribute(e,kAXSizeAttribute);
    AXValueRef pos=(__bridge AXValueRef)positionValue;
    AXValueRef size=(__bridge AXValueRef)sizeValue;
    CGPoint p;CGSize s;
    if(pos && size && CFGetTypeID(pos)==AXValueGetTypeID() && CFGetTypeID(size)==AXValueGetTypeID() &&
       AXValueGetValue(pos,kAXValueTypeCGPoint,&p) && AXValueGetValue(size,kAXValueTypeCGSize,&s) && s.width>0 && s.height>0 &&
       CGRectIntersectsRect(rect,CGRectMake(p.x,p.y,s.width,s.height))) {
      NSString *name=boundedText(attribute(e,kAXTitleAttribute),180);
      if(!name.length) name=boundedText(attribute(e,kAXDescriptionAttribute),180);
      if(!name.length) name=boundedText(attribute(e,CFSTR("AXPlaceholderValue")),180);
      NSMutableDictionary *item=[@{@"role":role,@"name":name,@"focused":@([attribute(e,kAXFocusedAttribute) boolValue]),
        @"disabled":@([attribute(e,kAXEnabledAttribute) isEqual:@NO]),
        @"bounds":@{@"left":@((p.x-rect.origin.x)*width/rect.size.width),@"top":@((p.y-rect.origin.y)*height/rect.size.height),
          @"width":@(s.width*width/rect.size.width),@"height":@(s.height*height/rect.size.height)}} mutableCopy];
      if(secure) item[@"value_redacted"]=@YES;
      else {id value=attribute(e,kAXValueAttribute);if([value isKindOfClass:[NSString class]]) item[@"value"]=boundedText(value,2000);}
      [items addObject:item];
    }
    if(!secure) {
      id children=attribute(e,kAXChildrenAttribute);
      if([children isKindOfClass:[NSArray class]]) for(id child in children) {
        if(queue.count>=300) break;
        if(CFGetTypeID((__bridge CFTypeRef)child)==AXUIElementGetTypeID()) [queue addObject:child];
      }
    }
  }
  NSData *json=[NSJSONSerialization dataWithJSONObject:@{@"elements":items} options:0 error:nil];
  if(json) std::cout.write((const char *)json.bytes,json.length);
}

// One foreground-window action per process. Never creates an application,
// changes privacy settings, handles credentials or evaluates model code.
int main() { @autoreleasepool {
  if (!AXIsProcessTrusted() || !CGPreflightScreenCaptureAccess()) return 2;
  std::string raw((std::istreambuf_iterator<char>(std::cin)), {});
  if (raw.size() > 65536) return 3;
  NSData *data = [NSData dataWithBytes:raw.data() length:raw.size()];
  NSDictionary *v = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![v isKindOfClass:[NSDictionary class]]) return 4;
  const bool inspect=[v[@"inspect"] boolValue];
  if(inspect && (![v[@"width"] doubleValue] || ![v[@"height"] doubleValue])) return 13;
  CGWindowID wid = (CGWindowID)[v[@"id"] longLongValue];
  NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID));
  NSDictionary *target = nil;
  for (NSDictionary *w in windows) if ([w[(__bridge id)kCGWindowNumber] unsignedIntValue] == wid) { target = w; break; }
  if (!target) return 5;
  NSString *name = [target[(__bridge id)kCGWindowOwnerName] lowercaseString];
  for (NSString *blocked in @[@"synora", @"codex", @"chatgpt", @"securityagent", @"loginwindow", @"system settings"]) if ([name containsString:blocked]) return 6;
  pid_t pid = [target[(__bridge id)kCGWindowOwnerPID] intValue];
  CGRect rect; if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)target[(__bridge id)kCGWindowBounds], &rect)) return 7;
  NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (!inspect && [NSWorkspace sharedWorkspace].frontmostApplication.processIdentifier != pid &&
      ![application activateWithOptions:NSApplicationActivateIgnoringOtherApps]) return 8;
  AXUIElementRef axApp = AXUIElementCreateApplication(pid);
  AXUIElementSetMessagingTimeout(axApp,0.3);
  ScopedCF appScope{axApp};
  CFArrayRef axWindows = nil;
  AXError err = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute, (CFTypeRef *)&axWindows);
  bool raised = false;
  AXUIElementRef axTarget = nil;
  if (err == kAXErrorSuccess && axWindows) {
    for (CFIndex n=0;n<CFArrayGetCount(axWindows);n++) {
      AXUIElementRef w = (AXUIElementRef)CFArrayGetValueAtIndex(axWindows,n);
      AXValueRef pos=nil,size=nil; CGPoint p; CGSize s;
      if (AXUIElementCopyAttributeValue(w,kAXPositionAttribute,(CFTypeRef *)&pos)==kAXErrorSuccess &&
          AXUIElementCopyAttributeValue(w,kAXSizeAttribute,(CFTypeRef *)&size)==kAXErrorSuccess &&
          AXValueGetValue(pos,kAXValueTypeCGPoint,&p) && AXValueGetValue(size,kAXValueTypeCGSize,&s) &&
          fabs(p.x-rect.origin.x)<2 && fabs(p.y-rect.origin.y)<2 && fabs(s.width-rect.size.width)<2 && fabs(s.height-rect.size.height)<2) {
        raised = inspect || focusedWindow(pid,axApp,w) || AXUIElementPerformAction(w,kAXRaiseAction)==kAXErrorSuccess;
        if (raised) {
          axTarget = (AXUIElementRef)CFRetain(w);
          if (!inspect && !focusedWindow(pid,axApp,w)) AXUIElementSetAttributeValue(w,kAXMainAttribute,kCFBooleanTrue);
        }
      }
      if(pos) CFRelease(pos); if(size) CFRelease(size); if(raised) break;
    }
    CFRelease(axWindows);
  }
  ScopedCF windowScope{axTarget};
  if (!raised) return 9;
  if(inspect) {inspectWindow(axTarget,rect,[v[@"width"] doubleValue],[v[@"height"] doubleValue]);return 0;}
  for(int attempt=0;attempt<50 && !focusedWindow(pid,axApp,axTarget);attempt++)
    { CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.01,false); [NSThread sleepForTimeInterval:0.01]; }
  if (!focusedWindow(pid,axApp,axTarget)) return 10;
  // Private event state cannot inherit a held user modifier. Address events to
  // the verified foreground process instead of racing the global HID queue.
  // AX + Screen Recording remain mandatory; no background or protected input.
  CGEventSourceRef source=CGEventSourceCreate(kCGEventSourceStatePrivate);
  ScopedCF sourceScope{source};
  if (!source) return 16;
  auto post = [&](CGEventRef event) {
    if (!event) return false;
    if (!focusedWindow(pid,axApp,axTarget)) { CFRelease(event); return false; }
    const CGEventType eventType=CGEventGetType(event);
    if (eventType==kCGEventKeyDown || eventType==kCGEventKeyUp || eventType==kCGEventFlagsChanged)
      CGEventPostToPid(pid,event);
    else
      CGEventPost(kCGSessionEventTap,event); // WindowServer performs mouse hit testing.
    CFRelease(event);
    CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.01,false);
    [NSThread sleepForTimeInterval:0.01];
    return true;
  };
  NSDictionary *i=v[@"input"]; NSString *type=i[@"type"];
  if ([type isEqualToString:@"text"]) {
    NSString *text=i[@"text"]; NSUInteger n=[text length]; if(n>4000) return 11;
    UniChar chars[4000]; [text getCharacters:chars range:NSMakeRange(0,n)];
    for(NSUInteger offset=0;offset<n;) {
      NSUInteger count=MIN((NSUInteger)20,n-offset);
      if(offset+count<n && chars[offset+count-1]>=0xD800 && chars[offset+count-1]<=0xDBFF) count--;
      for(bool down : {true,false}) {
        CGEventRef event=CGEventCreateKeyboardEvent(source,0,down);
        CGEventSetFlags(event,0); CGEventKeyboardSetUnicodeString(event,count,chars+offset);
        if(!post(event)) return 17;
      }
      offset+=count;
    }
  } else if ([type isEqualToString:@"key"]) {
    NSDictionary *keys=@{@"Enter":@36,@"Tab":@48,@"Escape":@53,@"Backspace":@51,@"Delete":@117,@"ArrowUp":@126,@"ArrowDown":@125,@"ArrowLeft":@123,@"ArrowRight":@124,@"Home":@115,@"End":@119,@"PageUp":@116,@"PageDown":@121,@"a":@0};
    NSArray *parts=[i[@"key"] componentsSeparatedByString:@"+"]; NSNumber *code=keys[parts.lastObject]; if(!code) return 12;
    CGEventFlags flags=parts.count>1 ? ([parts[0] isEqualToString:@"Shift"] ? kCGEventFlagMaskShift : [parts[0] isEqualToString:@"Control"] ? kCGEventFlagMaskControl : kCGEventFlagMaskCommand) : 0;
    for (bool down : {true,false}) { CGEventRef e=CGEventCreateKeyboardEvent(source,code.unsignedShortValue,down); CGEventSetFlags(e,flags); if(!post(e)) return 17; }
  } else {
    double width=[v[@"width"] doubleValue], height=[v[@"height"] doubleValue]; if(width<=0 || height<=0) return 13;
    double x=[i[@"x"] doubleValue], y=[i[@"y"] doubleValue]; if(x<0 || y<0 || x>=width || y>=height) return 14;
    CGPoint p=CGPointMake(rect.origin.x+x*rect.size.width/width,rect.origin.y+y*rect.size.height/height);
    CGEventRef move=CGEventCreateMouseEvent(source,kCGEventMouseMoved,p,kCGMouseButtonLeft); CGEventSetFlags(move,0); if(!post(move)) return 17;
    if ([type isEqualToString:@"click"]) {
      NSString *b=i[@"button"]; CGMouseButton button=[b isEqualToString:@"right"]?kCGMouseButtonRight:[b isEqualToString:@"middle"]?kCGMouseButtonCenter:kCGMouseButtonLeft;
      CGEventType down=button==kCGMouseButtonRight?kCGEventRightMouseDown:button==kCGMouseButtonCenter?kCGEventOtherMouseDown:kCGEventLeftMouseDown;
      CGEventType up=button==kCGMouseButtonRight?kCGEventRightMouseUp:button==kCGMouseButtonCenter?kCGEventOtherMouseUp:kCGEventLeftMouseUp;
      for(CGEventType t : {down,up}) { CGEventRef e=CGEventCreateMouseEvent(source,t,p,button); CGEventSetFlags(e,0); CGEventSetIntegerValueField(e,kCGMouseEventClickState,1); if(!post(e)) return 17; }
    } else if ([type isEqualToString:@"scroll"]) {
      CGEventRef e=CGEventCreateScrollWheelEvent(source,kCGScrollEventUnitPixel,2,-[i[@"deltaY"] intValue],-[i[@"deltaX"] intValue]); CGEventSetLocation(e,p); CGEventSetFlags(e,0); if(!post(e)) return 17;
    } else return 15;
  }
  std::cout << "ok"; return 0;
} }
