// @refresh reset
import React, { useEffect, useRef, useLayoutEffect, memo } from 'react';
import { View, findNodeHandle } from 'react-native';
import SharedValue from './SharedValue';
import Worklet from './Worklet';
import WorkletEventHandler from './WorkletEventHandler';
import NativeModule from './NativeReanimated';

function isShareable(obj) {
  if (obj instanceof SharedValue) {
    return true;
  }

  // We don't wrap array in SharedValue because we cannot override [] operator.
  // We add propery instead
  if (Array.isArray(obj)) {
    if (obj.sharedArray) {
      return true;
    }
  }

  if (obj instanceof SharedValue) {
    return true;
  }

  return false;
}

// returns [obj, release]
function makeShareable(obj) {
  const toRelease = [];

  if (isShareable(obj)) {
    return [obj, () => {}];
  }

  if (Array.isArray(obj)) {
    obj = obj.slice();
    let i = 0;
    for (let element of obj) {
      const [res, release] = makeShareable(element);
      obj[i] = res;
      toRelease.push(release);
      i++;
    }

    const sharedArray = SharedValue.create(obj);
    toRelease.push(() => {
      sharedArray.release();
    });

    obj.id = sharedArray.id;
    obj.sharedArray = sharedArray;
  } else if (typeof obj === 'object' && !(obj instanceof Worklet)) {
    obj = Object.assign({}, obj);

    for (let property in obj) {
      const [res, release] = makeShareable(obj[property]);
      obj[property] = res;
      toRelease.push(release);
    }
    obj = SharedValue.create(obj);
    toRelease.push(() => {
      obj.release();
    });
  } else {
    let workletHolder = null;
    if (typeof obj === 'function' && obj.isWorklet == null) {
      obj = new Worklet(obj);
      workletHolder = obj;
    }
    obj = SharedValue.create(obj);
    const release = obj.release.bind(obj);
    toRelease.push(function() {
      release();
      if (workletHolder != null) {
        workletHolder.release();
      }
    });
  }

  const release = () => {
    for (let rel of toRelease) {
      rel();
    }
  };

  return [obj, release];
}

function transformArgs(args) {
  const toRelease = [];
  for (let i = 0; i < args.length; i++) {
    const [sv, release] = makeShareable(args[i]);
    args[i] = sv;
    toRelease.push(release);
  }

  return () => {
    for (let release of toRelease) {
      release();
    }
  };
}

function commonCode(body, args, createRes) {
  const res = useRef(null);
  const releaseObj = useRef(null);

  const init = function() {
    console.log('init common code');
    let argsCopy = [];
    if (args !== undefined) {
      if (Array.isArray(args)) {
        argsCopy = isShareable(args) ? args : args.slice();
      } else if (typeof args === 'object' && args !== null) {
        if (isShareable(args)) {
          argsCopy = [args];
        } else {
          // force object copy operation
          argsCopy = [
            { ...args, __________reanimated_object_unreachable_field_name: 0 },
          ];
          delete argsCopy[0][
            '__________reanimated_object_unreachable_field_name'
          ];
        }
      }
    }
    let shouldReleaseWorklet = false;
    if (typeof body === 'function') {
      shouldReleaseWorklet = true;
      body = new Worklet(body);
    }
    const release = transformArgs(argsCopy);
    let releaseApplierHolder = { get: () => {} };

    res.current = createRes(releaseApplierHolder, body, argsCopy);

    res.current.start = res.current;
    res.current.startMapping = res.current;
    res.current.setListener = fun => {
      body.setListener(fun);
    };
    res.current.isWorklet = true;
    res.current.body = body;
    res.current.args = argsCopy;
    res.current.stop = () => {
      releaseApplierHolder.get();
    };
    return { shouldReleaseWorklet, releaseApplierHolder, release, body };
  };

  if (res.current == null) {
    releaseObj.current = init();
  }

  useEffect(() => {
    return () => {
      if (!releaseObj.current) return;
      console.log('clear common code');
      releaseObj.current.releaseApplierHolder.get();
      releaseObj.current.release();
      if (releaseObj.current.shouldReleaseWorklet) {
        releaseObj.current.body.release();
      }
      res.current = null;
    };
  }, []);

  return res.current;
}

export function useWorklet(body, args) {
  console.log('useWorklet');
  return commonCode(body, args, (releaseApplierHolder, body, argsCopy) => {
    return () => {
      console.log('startAnimation');
      releaseApplierHolder.get = body.apply(argsCopy);
    };
  });
}

export function useMapper(body, args) {
  console.log('useMapper');
  return commonCode(body, args, (releaseApplierHolder, body, argsCopy) => {
    return () => {
      releaseApplierHolder.get = body.registerAsMapper(argsCopy);
    };
  });
}

export function useEventWorklet(body, args) {
  console.log('useEventWorklet');
  return commonCode(body, args, (releaseApplierHolder, body, argsCopy) => {
    return new WorkletEventHandler(body, argsCopy);
  });
}

export function useSharedValue(initial) {
  console.log('useShared');
  const sv = useRef(null);
  let release = () => {};

  const init = () => {
    console.log('init');
    [sv.current, release] = makeShareable(initial);
    return release;
  };

  if (sv.current == null) {
    release = init();
  }

  useEffect(() => {
    console.log('sharedValue useEffect');

    return () => {
      if (sv.current) {
        release();
        sv.current = null;
      }
      console.log('clear');
    };
  }, []);

  return sv.current;
}

const styleUpdater2 = new Worklet(function(input, output) {
  'worklet';
  const newValues = input.body.apply(this, [input.input]);
  Reanimated.assign(output, newValues);
});

const styleUpdater3 = new Worklet(function(input, output, accessories) {
  'worklet';
  const newValues = input.body.apply(this, [input.input, accessories]);
  Reanimated.assign(output, newValues);
});

function unwrap(obj) {
  if (Array.isArray(obj)) {
    const res = [];
    for (let ele of obj) {
      res.push(unwrap(ele));
    }
    return res;
  }

  const initialValue = obj.initialValue;

  if (typeof initialValue === 'object') {
    if (initialValue.isWorklet) {
      return { start: () => {}, stop: () => {} };
    }

    if (initialValue.isFunction) {
      return obj._data;
    }

    if (initialValue.isObject) {
      const res = {};
      for (let propName of initialValue.propNames) {
        res[propName] = unwrap(obj[propName]);
      }
      return res;
    }
  }

  return { value: initialValue };
}

function copyAndUnwrap(obj) {
  if (Array.isArray(obj)) {
    const res = [];
    for (let ele of obj) {
      res.push(copyAndUnwrap(ele));
    }
    return res;
  }

  if (!obj.initialValue) {
    if (Object.keys(obj).length == 1 && obj.value) {
      return obj.value;
    }
    if (typeof obj === 'object') {
      for (let propName of Object.keys(obj)) {
        obj[propName] = copyAndUnwrap(obj[propName]);
      }
    }
    return obj;
  }

  if (obj.initialValue.isObject) {
    const res = {};
    for (let propName of initialValue.propNames) {
      res[propName] = copyAndUnwrap(obj[propName]);
    }
    return res;
  }

  // it has to be base shared type
  return obj.initialValue;
}

function sanitize(style) {
  const sanitized = {};
  Object.keys(style).forEach(key => {
    const value = style[key];
    if (typeof value === 'object') {
      if (value.value !== undefined) {
        sanitized[key] = value.value;
        return;
      } else if (value.animation) {
        // do nothing
        return;
      }
    }
    sanitized[key] = value;
  });
  return sanitized;
}

export function ReanimatedView(props) {
  const animatedStyle = props.style.filter(
    style => style.viewTag !== undefined
  );
  const processedStyle = props.style.map(style => {
    if (style.viewTag) {
      // animated
      return style.eval();
    } else {
      return style;
    }
  });

  const ref = useRef(null);
  useEffect(() => {
    const viewTag = findNodeHandle(ref.current);
    animatedStyle.forEach(style => {
      style.viewTag.set(viewTag);
    });
  }, [ref]);

  return <View {...props} style={processedStyle} ref={ref} />;
}

const animationUpdater7 = new Worklet(function(viewTag, styleApplierId) {
  'worklet';
  const animations = Reanimated.container[styleApplierId.value].animations;
  const updates = {};
  let allFinished = true;
  let haveUpdates = false;
  Object.keys(animations).forEach(propKey => {
    const animation = animations[propKey];
    if (!animation.finished) {
      const finished = animation.animation(animation);
      updates[propKey] = animation.current;
      haveUpdates = true;
      if (!finished) {
        allFinished = false;
      } else {
        animation.finished = true;
      }
    }
  });
  if (haveUpdates) {
    _updateProps(viewTag.value, updates);
  }
  return allFinished;
});

const styleUpdater7 = new Worklet(function(input, applierId) {
  'worklet';
  const memory = Reanimated.memory(this);
  const animations = memory.animations || {};
  const oldValues = memory.last || {};
  const newValues = input.body(input.input);

  function styleDiff(oldStyle, newStyle) {
    const diff = {};
    Object.keys(oldStyle).forEach(key => {
      if (newStyle[key] === undefined) {
        diff[key] = null;
      }
    });
    Object.keys(newStyle).forEach(key => {
      const value = newStyle[key];
      const oldValue = oldStyle[key];

      if (typeof value === 'object') {
        if (value.value !== undefined) {
          // shared value
          if (oldValue !== value.value) {
            diff[key] = value.value;
          }
          return;
        } else if (value.animation) {
          // animation
          return;
        }
        diff[key] = value;
        return;
      }
      if (oldValue !== value) {
        diff[key] = value;
        return;
      }
    });
    return diff;
  }

  function getLastValue(key) {
    const value = oldValues[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === 'object') {
      if (value.value !== undefined) {
        return value.value;
      }
      if (value.animation !== undefined) {
        return animations[key].current;
      }
    }
    return value;
  }

  // extract animated props
  let hasAnimations = false;
  Object.keys(animations).forEach(key => {
    const value = newValues[key];
    if (typeof value === 'object' && value.animation) {
      value;
      // animation will be updated in the next step, we are here just
      // to cancel removed animations
    } else {
      delete animations[key];
    }
  });
  Object.keys(newValues).forEach(key => {
    const value = newValues[key];
    if (typeof value === 'object' && value.animation) {
      // console.log('VVV ' + JSON.stringify(value));
      value.current = getLastValue(key) || value.current;
      value.velocity = animations[key] ? animations[key].velocity : 0;
      animations[key] = value;
      hasAnimations = true;
    }
  });

  if (hasAnimations) {
    memory.animations = animations;
    applierId.set(this.applierId);
    input.animation.start();
  } else {
    input.animation.stop();
    memory.animations = {};
  }

  // calculate diff
  const diff = styleDiff(oldValues, newValues);
  memory.last = Object.assign({}, oldValues, newValues);

  if (Object.keys(diff).length !== 0) {
    _updateProps(input.viewTag.value, diff);
  }
});

export function useAnimatedStyle(body, input) {
  const viewTag = useSharedValue(-1);
  const sharedBody = useSharedValue(body);
  const sharedInput = useSharedValue(input);
  const mockInput = unwrap(sharedInput, true);
  const wtf = useSharedValue(-1);
  const animation = useWorklet(animationUpdater7, [viewTag, wtf]);

  const mapper = useMapper(styleUpdater7, [
    {
      input: sharedInput,
      viewTag,
      body: sharedBody,
      animation,
    },
    wtf,
  ]);

  useEffect(() => {
    mapper.startMapping();
  }, []);

  return {
    viewTag,
    mapper,
    eval: () => sanitize(body(mockInput)),
  };
}

export function removeSharedObjsAndArrays(obj) {
  if (Array.isArray(obj)) {
    const res = [];
    for (let element of obj) {
      res.push(removeSharedObjsAndArrays(element));
    }
    return res;
  }

  if (typeof obj === 'object') {
    if (obj instanceof SharedValue) {
      if (obj.initialValue.isObject) {
        const res = {};
        for (let propName of obj.initialValue.propNames) {
          res[propName] = removeSharedObjsAndArrays(obj[propName]);
        }
        return res;
      }
      return obj;
    } else {
      let res = {};
      for (let propName of Object.keys(obj)) {
        res[propName] = removeSharedObjsAndArrays(obj[propName]);
      }
      return res;
    }
  }

  return obj;
}

export function install(path, val) {
  if (
    !['string', 'number', 'boolean', 'function'].includes(typeof val) &&
    val !== undefined
  ) {
    return;
  }
  if (typeof val === 'function') {
    NativeModule.workletEval(path, `(${val.asString})`);
    return;
  }
  if (val === undefined) {
    val = '{}';
  } else {
    val = typeof val === 'string' ? `"${val}"` : val.toString();
  }
  NativeModule.workletEval(path, val);
}
