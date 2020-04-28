//
//  NativeProxy.m
//  DoubleConversion
//
//  Created by Szymon Kapala on 27/02/2020.
//

#import "NativeProxy.h"
#include <folly/json.h>
#import <React/RCTFollyConvert.h>
#import <React/RCTUIManager.h>
#import "IOSScheduler.h"
#import "IOSErrorHandler.h"
#import <jsi/JSCRuntime.h>
#import "RuntimeDecorator.h"

// COPIED FROM RCTTurboModule.mm
static id convertJSIValueToObjCObject(jsi::Runtime &runtime, const jsi::Value &value);

static NSString *convertJSIStringToNSString(jsi::Runtime &runtime, const jsi::String &value)
{
  return [NSString stringWithUTF8String:value.utf8(runtime).c_str()];
}

static NSDictionary *convertJSIObjectToNSDictionary(jsi::Runtime &runtime, const jsi::Object &value)
{
  jsi::Array propertyNames = value.getPropertyNames(runtime);
  size_t size = propertyNames.size(runtime);
  NSMutableDictionary *result = [NSMutableDictionary new];
  for (size_t i = 0; i < size; i++) {
    jsi::String name = propertyNames.getValueAtIndex(runtime, i).getString(runtime);
    NSString *k = convertJSIStringToNSString(runtime, name);
    id v = convertJSIValueToObjCObject(runtime, value.getProperty(runtime, name));
    if (v) {
      result[k] = v;
    }
  }
  return [result copy];
}

static NSArray *
convertJSIArrayToNSArray(jsi::Runtime &runtime, const jsi::Array &value)
{
  size_t size = value.size(runtime);
  NSMutableArray *result = [NSMutableArray new];
  for (size_t i = 0; i < size; i++) {
    // Insert kCFNull when it's `undefined` value to preserve the indices.
    [result
        addObject:convertJSIValueToObjCObject(runtime, value.getValueAtIndex(runtime, i)) ?: (id)kCFNull];
  }
  return [result copy];
}

static id convertJSIValueToObjCObject(jsi::Runtime &runtime, const jsi::Value &value)
{
  if (value.isUndefined() || value.isNull()) {
    return nil;
  }
  if (value.isBool()) {
    return @(value.getBool());
  }
  if (value.isNumber()) {
    return @(value.getNumber());
  }
  if (value.isString()) {
    return convertJSIStringToNSString(runtime, value.getString(runtime));
  }
  if (value.isObject()) {
    jsi::Object o = value.getObject(runtime);
    if (o.isArray(runtime)) {
      return convertJSIArrayToNSArray(runtime, o.getArray(runtime));
    }
    return convertJSIObjectToNSDictionary(runtime, o);
  }

  throw std::runtime_error("Unsupported jsi::jsi::Value kind");
}

@interface NativeProxy()

@end

std::shared_ptr<NativeReanimatedModule> nativeReanimatedModule;
std::shared_ptr<IOSScheduler> scheduler;

@implementation NativeProxy

+ (void)clear
{
  scheduler.reset();
  nativeReanimatedModule.reset();
}

+ (NSArray<NSArray*>*) getChangedSharedValuesAfterRender
{
  try {
    if (nativeReanimatedModule->errorHandler->getError() == nullptr ||
        !nativeReanimatedModule->errorHandler->getError()->handled) {
      nativeReanimatedModule->render();
    }
  } catch(const std::exception &e) {
    if (nativeReanimatedModule->errorHandler->getError() == nullptr) {
      std::string message = "error occured: ";
      message += e.what();
      nativeReanimatedModule->errorHandler->raise(message.c_str());
    }
  }
  return [NativeProxy getChangedSharedValues];
}

+ (NSArray<NSArray*>*) getChangedSharedValuesAfterEvent:(NSString *)eventName event:(id<RCTEvent>)event
{
  std::string eventNameStdString([eventName UTF8String]);

  std::string eventAsString = folly::toJson(convertIdToFollyDynamic([event arguments][2]));
  eventAsString = "{ NativeMap:"  + eventAsString + "}";
  try {
    if (nativeReanimatedModule->errorHandler->getError() == nullptr ||
        !nativeReanimatedModule->errorHandler->getError()->handled) {
      nativeReanimatedModule->onEvent(eventNameStdString, eventAsString);
    }
  } catch(const std::exception &e) {
    if (nativeReanimatedModule->errorHandler->getError() == nullptr) {
      std::string message = "error occured: ";
      message += e.what();
      nativeReanimatedModule->errorHandler->raise(message.c_str());
    }
  }
  return  [NativeProxy getChangedSharedValues];
}

+ (BOOL)shouldEventBeHijacked:(NSString*)eventName
{
  std::string eventNameStdString([eventName UTF8String]);
  return nativeReanimatedModule->applierRegistry->anyApplierRegisteredForEvent(eventNameStdString);
}

+ (BOOL)shouldRerender
{
  bool should = nativeReanimatedModule->applierRegistry->notEmpty();
  should = should or nativeReanimatedModule->mapperRegistry->updatedSinceLastExecute;
  return should;
}

+ (void*) getNativeReanimatedModule:(void*)jsInvokerVoidPtr
{
  std::shared_ptr<JSCallInvoker> jsInvoker = *(static_cast<std::shared_ptr<JSCallInvoker>*>(jsInvokerVoidPtr));

  scheduler = std::make_shared<IOSScheduler>(jsInvoker);

  std::shared_ptr<Scheduler> schedulerForModule(scheduler);
  std::shared_ptr<ErrorHandler> errorHandler((ErrorHandler*)new IOSErrorHandler(schedulerForModule));
  std::shared_ptr<WorkletRegistry> workletRegistry(new WorkletRegistry());
  std::shared_ptr<SharedValueRegistry> sharedValueRegistry(new SharedValueRegistry());
  std::shared_ptr<MapperRegistry> mapperRegistry(new MapperRegistry(sharedValueRegistry));
  std::shared_ptr<ApplierRegistry> applierRegistry(new ApplierRegistry(mapperRegistry));
  std::unique_ptr<jsi::Runtime> animatedRuntime(static_cast<jsi::Runtime*>(facebook::jsc::makeJSCRuntime().release()));


  RCTBridge *bridge;
  if ([[UIApplication sharedApplication].delegate respondsToSelector:@selector(bridge)]) {
    bridge = [[UIApplication sharedApplication].delegate performSelector:@selector(bridge) withObject:[UIApplication sharedApplication].delegate];
  }

  auto updater = [bridge](jsi::Runtime &rt, int viewTag, const jsi::Object &props) -> void {
    NSDictionary *propsDict = convertJSIObjectToNSDictionary(rt, props);
    [bridge.uiManager synchronouslyUpdateViewOnUIThread:[NSNumber numberWithInt:viewTag] viewName:@"RCTView" props:propsDict];
  };
  RuntimeDecorator::addNativeObjects(*animatedRuntime, updater);

  nativeReanimatedModule = std::make_shared<NativeReanimatedModule>(std::move(animatedRuntime),
  applierRegistry,
  sharedValueRegistry,
  workletRegistry,
  schedulerForModule,
  mapperRegistry,
  jsInvoker,
  errorHandler);

  return (void*)(&nativeReanimatedModule);
}

+ (NSArray<NSArray*>*)getChangedSharedValues
{
  NSMutableArray *changed = [NSMutableArray new];
  for(auto & sharedValue : nativeReanimatedModule->sharedValueRegistry->getSharedValueMap()) {
    int svId = sharedValue.first;
    std::shared_ptr<SharedValue> sv = sharedValue.second;
    if ((!sv->dirty) || (!sv->shouldBeSentToJava)) {
      continue;
    }
    sv->dirty = false;

    NSNumber *sharedValueId = [NSNumber numberWithInteger: svId];
    NSObject *value = [self sharedValueToNSObject: (void*)(sv.get())];
    if (value == nullptr) {
      RCTLogError(@"Shared value not found");
    }
    [changed addObject:@[sharedValueId, value]];
  }

  return changed;
}

+ (NSObject*)getSharedValue: (double) id
{
    std::shared_ptr<SharedValue> sv = nativeReanimatedModule->sharedValueRegistry->getSharedValue(id);
    return [self sharedValueToNSObject: (void*)(sv.get())];
}


+ (NSObject*)sharedValueToNSObject: (void*) sv
{
    if (sv == nullptr) {
        return nullptr;
    }
    SharedValue* svptr = (SharedValue*)sv;
    NSObject *value;

    switch (svptr->type)
    {
        case SharedValueType::shared_double:
        {
            double dvalue = ((SharedDouble*)(svptr))->value;
            value = [NSNumber numberWithDouble:dvalue];
            break;
        }
        case SharedValueType::shared_string:
        {
            std::string str = ((SharedString*)(svptr))->value;
            value = [NSString stringWithCString:str.c_str()
            encoding:[NSString defaultCStringEncoding]];
            break;
        }
        default: {
            return nullptr;
        }
    }
    return value;
}

@end
