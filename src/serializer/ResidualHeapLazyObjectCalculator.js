/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import type { Logger } from "./logger.js";
import type { Modules } from "./modules.js";
import type { Realm } from "../realm.js";
import type { Effects } from "../realm.js";

import invariant from "../invariant.js";
import {
  Value,
  EmptyValue,
  FunctionValue,
  AbstractValue,
  SymbolValue,
  ProxyValue,
  ObjectValue,
} from "../values/index.js";
import { ResidualHeapInspector } from "./ResidualHeapInspector.js";
import { ResidualHeapVisitor } from "./ResidualHeapVisitor.js";
import { ResidualHeapDominatorGraph } from "./ResidualHeapDominatorGraph.js";

export class ResidualHeapLazyObjectCalculator extends ResidualHeapVisitor {
  constructor(
    realm: Realm,
    logger: Logger,
    modules: Modules,
    additionalFunctionValuesAndEffects: Map<FunctionValue, Effects>,
    valueToEdgeRecord: Map<Value, [number, number]>
  ) {
    super(realm, logger, modules, additionalFunctionValuesAndEffects);
    this._valueToEdgeRecord = valueToEdgeRecord;
    this._lazyObjects = new Set();
    this._visitedValues = new Set();
    this._statistics = {
      rc1: 0,
      rc2: 0,
      others: 0,
      breakNodeCount: 0,
      whiteFunctionBenefit: 0,
      breakNodeDominatorBenefit: 0,
      breakNodes: {
        func: 0,
        abstract: 0,
        proxy: 0,
        symbol: 0,
        object: 0,
        others: 0,
      },
      popularBreakNodes: {
        func: 0,
        abstract: 0,
        proxy: 0,
        symbol: 0,
        object: 0,
        others: 0,
      },
    };
    const dominatorGraph = new ResidualHeapDominatorGraph(realm, logger, modules, additionalFunctionValuesAndEffects);
    this._immediateDominators = dominatorGraph.construct();
    this._breakNodeImmediateDominators = new Set();
  }

  _valueToEdgeRecord: Map<Value, [number, number]>;
  _lazyObjects: Set<Value>;
  _visitedValues: Set<Value>;
  _statistics: any;
  _immediateDominators: Map<Value, Value>;
  _breakNodeImmediateDominators: Set<Value>;

  _mark(val: Value): boolean {
    if (this._visitedValues.has(val)) {
      return false; // Already visited.
    }
    this._visitedValues.add(val);
    return true;
  }

  _recordBreakNodeStatistics(val: Value, breakNode: any) {
    if (val instanceof FunctionValue) {
      ++breakNode.func;
    } else if (val instanceof AbstractValue) {
      ++breakNode.abstract;
    } else if (val instanceof ProxyValue) {
      ++breakNode.proxy;
    } else if (val instanceof SymbolValue) {
      ++breakNode.symbol;
    } else if (val instanceof ObjectValue) {
      ++breakNode.object;
    } else {
      ++breakNode.others;
    }
  }

  _processBreakNode(breakNode: Value, refCount: number) {
    const immediateDominator = this._immediateDominators.get(breakNode);
    if (immediateDominator != null) {
      this._breakNodeImmediateDominators.add(immediateDominator);
    }
    ++this._statistics.breakNodeCount;
    this._recordBreakNodeStatistics(breakNode, this._statistics.breakNodes);
    if (refCount > 20) {
      this._recordBreakNodeStatistics(breakNode, this._statistics.popularBreakNodes);
    }
  }

  _canValueBeLazy(val: Value, childrenPassCheck: boolean): boolean {
    //const foreverObjectNames = ["runnables", "shim"];
    //const originalName = val.__originalName || "";
    const isValueBreakNodeDominator = this._breakNodeImmediateDominators.has(val);
    if (!childrenPassCheck) {
      if (val instanceof FunctionValue) {
        this._statistics.whiteFunctionBenefit++;
      } else {
        if (isValueBreakNodeDominator) {
          this._statistics.breakNodeDominatorBenefit++;
        }
      }
    }
    return (
      childrenPassCheck ||
      //foreverObjectNames.indexOf(originalName) !== -1 ||
      val instanceof FunctionValue ||
      isValueBreakNodeDominator
    );
  }

  _postProcessValue(val: Value, childrenPassCheck: boolean): boolean {
    if (val instanceof EmptyValue || val.isIntrinsic() || ResidualHeapInspector.isLeaf(val)) {
      // Leaf should have no children.
      return true;
    }
    let edgeRecord = this._valueToEdgeRecord.get(val);
    invariant(edgeRecord != null);
    const refCount = edgeRecord[0];

    const canValueBeLazy = this._canValueBeLazy(val, childrenPassCheck);
    if (!this._lazyObjects.has(val) && canValueBeLazy) {
      this._lazyObjects.add(val);
      if (refCount > 1) {
        this._processBreakNode(val, refCount);
      }
    }
    return refCount === 1 && canValueBeLazy;
  }

  repotResult() {
    invariant(this._valueToEdgeRecord.size >= this._lazyObjects.size);
    this._statistics = Array.from(this._valueToEdgeRecord.values()).reduce((prev: any, edgeRecord) => {
      let rc = edgeRecord[0];
      invariant(rc > 0);
      if (rc === 1) {
        ++prev.rc1;
      } else if (rc === 2) {
        ++prev.rc2;
      } else {
        ++prev.others;
      }
      return prev;
    }, this._statistics);
    console.log(`Ref count statistics: [${JSON.stringify(this._statistics)}]`);
    console.log(`JS Heap: total[${this._valueToEdgeRecord.size}], lazy object[${this._lazyObjects.size}]\n`);
  }
}
