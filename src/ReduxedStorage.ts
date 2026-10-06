import type {
  Action, Reducer,
  Observer, Observable, Unsubscribe
} from 'redux';
import { v4 as uuid } from 'uuid';
import WrappedStorage from './WrappedStorage';
import { cloneDeep, isEqual, diffDeep, mergeOrReplace } from './utils';
import type { ChangeListener } from './types/listeners';
import type {
  ActionExtension, ExtendedStore, StoreCreatorContainer
} from './types/store';

type StandardListener = () => void;

const packState = (state: any, id: string, ts: number): [string, number, any] =>
  [id, ts, state];

export const unpackState = (data: any): [any, string, number] => {
  if (typeof data === 'undefined' || !Array.isArray(data) || data.length !== 3)
    return [data, '', 0];
  const [ id, ts, state ] = data;
  return typeof id === 'string' && typeof ts === 'number' ?
    [ state, id, ts ] :
    [data, '', 0];
}

export default class ReduxedStorage<
  W extends WrappedStorage<any>, A extends Action
> {
  container: StoreCreatorContainer;
  storage: W;
  isolated?: boolean;
  plain?: boolean;
  delay?: number;
  timeout: number;
  resetState: any;
  store: ExtendedStore;
  state: any;
  id: string;
  tmstamp: number;
  timerId?: any;
  lisner?: ChangeListener;
  lisners: StandardListener[];
  unsub?: Unsubscribe;
  outdted: [number, Unsubscribe][];

  constructor(
    container: StoreCreatorContainer, storage: W,
    isolated?: boolean, plainActions?: boolean,
    syncDelay?: number, outdatedTimeout?: number,
    localChangeListener?: ChangeListener, resetState?: any
  ) {
    this.container = container;
    this.storage = storage;
    this.isolated = isolated;
    this.plain = plainActions;
    this.delay = syncDelay? Math.min(Math.max(syncDelay, 50), 500) : 0;
    this.timeout = outdatedTimeout? Math.max(outdatedTimeout, 500) : 1000;
    this.resetState = resetState;
    this.store = this._instantiateStore();
    this.state = null;
    this.id = uuid();
    this.tmstamp = 0;
    this.outdted = [];
    if (typeof localChangeListener === 'function')
      this.lisner = localChangeListener;
    this.lisners = [];
    this.getState = this.getState.bind(this);
    this.subscribe = this.subscribe.bind(this);
    this.dispatch = this.dispatch.bind(this);
    this.replaceReducer = this.replaceReducer.bind(this);
    this[Symbol.observable] = this[Symbol.observable].bind(this);
    console.log(`Reduxed.constructor(): id=${this.id}; container=${typeof this.container}; resetState=${resetState}; isolated=${this.isolated}; plain=${this.plain}; delay=${this.delay}; timeout=${this.timeout}`);
  }

  init(): Promise<ExtendedStore> {
    console.log(`Reduxed.init():`);
    // return a promise to be resolved when the last saved state (if any)
    // is restored from chrome.storage
    return new Promise( resolve => {
      const defaultState = this.store.getState();
      this.tmstamp? resolve(this as ExtendedStore) : this.storage.load(data => {
        const [storedState, , timestamp] = unpackState(data);
        console.log(`Reduxed.init.onLoad: this.id=${this.id}; timestamp=${timestamp}; defaultState=${JSON.stringify(defaultState)}; storedState=${JSON.stringify(storedState)}; resetState=${JSON.stringify(this.resetState)}(${typeof this.resetState})`);
        let newState = storedState?
          mergeOrReplace(defaultState, storedState) : defaultState;
        if (this.resetState) {
          newState = mergeOrReplace(newState, this.resetState);
        }
        this._setState(newState, timestamp);
        this._renewStore();
        isEqual(newState, storedState) || this._send2Storage();
        this.isolated || this.storage.subscribe( (data, oldData) => {
          const [ state, id, timestamp ] = unpackState(data);
          console.log(`Reduxed.init.onChange(): data=${JSON.stringify(data)}; oldData=${JSON.stringify(oldData)}; state=${JSON.stringify(state)}; this.state=${JSON.stringify(this.state)}; isEqual(state, this.state)=${isEqual(state, this.state)}; id=${id}; this.id=${this.id}; timestamp=${timestamp}; this.tmstamp=${this.tmstamp}; n(lisners)=${this.lisners.length}`);
          if (id === this.id || isEqual(state, this.state))
            return;
          const newTime = timestamp >= this.tmstamp;
          const newState = newTime ?
            mergeOrReplace(this.state, state, true) :
            mergeOrReplace(state, this.state, true);
          console.log(` newState=${JSON.stringify(newState)}`);
          if (!newTime && isEqual(newState, this.state))
            return;
          this._setState(newState, timestamp);
          this._renewStore();
          isEqual(newState, state) || this._send2Storage();
          this._callListeners();
        });
        resolve(this as ExtendedStore);
      });
    });
  }

  initFrom(state: any): ExtendedStore {
    this._setState(state, 0);
    this._renewStore();
    return this as ExtendedStore;
  }

  _setState(data: any, timestamp?: number) {
    console.log(`Reduxed._setState(): data=${JSON.stringify(data)}; timestamp=${timestamp}; this.tmstamp=${this.tmstamp}; this.id=${this.id}`);
    this.state = cloneDeep(data);
    timestamp = typeof timestamp !== 'undefined'? timestamp : Date.now();
    if (timestamp > this.tmstamp) {
      this.tmstamp = timestamp;
    }
    console.log(` timestamp=${timestamp}; this.tmstamp=${this.tmstamp}`);
  }

  _renewStore() {
    console.log(`Reduxed._renewStore(): this.id=${this.id}; this.state=${JSON.stringify(this.state)}`);
    this.plain? this.unsub && this.unsub() : this._clean();
    const store = this.store = this._instantiateStore(this.state);
    const now = Date.now();
    const n = this.outdted.length;
    this.outdted = this.outdted.map( ([t, u], i) =>
      t || i >= n-1 ? [t, u] : [now, u]
    );
    console.log(` outdted=${JSON.stringify(this.outdted)}; now=${now}`);
    let state0 = cloneDeep(this.state);
    const unsubscribe = this.store.subscribe( () => {
      const state = store && store.getState();
      const sameStore = this.store === store;
      console.log(`Reduxed._renewStore:subscribe-callback: sameStore=${JSON.stringify(sameStore)}; state=${JSON.stringify(state)}; isEqual=${isEqual(state, this.state)}; state0=${JSON.stringify(state0)}`);
      this._clean();
      if (isEqual(state, this.state))
        return;
      if (sameStore) {
        this._setState(state);
      } else {
        const diff = diffDeep(state, state0);
        console.log(` diff=${JSON.stringify(diff)}`);
        if (typeof diff === 'undefined')
          return;
        this._setState(mergeOrReplace(this.state, diff));
        this._renewStore();
      }
      this.delay? this._send2StorageDelayd() : this._send2Storage();
      this._callListeners(true, state0);
      state0 = cloneDeep(state);
    });
    if (this.plain)
      this.unsub = unsubscribe;
    else
      this.outdted.push([0, unsubscribe]);
  }

  _clean() {
    if (this.plain)
      return;
    const now = Date.now();
    const n = this.outdted.length;
    console.log(`Reduxed._clean(): this.id=${this.id}; outdted=${JSON.stringify(this.outdted)}; now=${now}`);
    this.outdted.forEach( ([timestamp, unsubscribe], i) => {
      if (i >= n-1 || now - timestamp < this.timeout)
        return;
      unsubscribe();
      delete this.outdted[i];
      console.log(` deleted outdted #${i}: timestamp=${timestamp}`);
    });
    console.log(` outdted=${JSON.stringify(this.outdted)}`);
  }

  _instantiateStore(state?: any) {
    const store = this.container(state);
    if (typeof store !== 'object' || typeof store.getState !== 'function')
      throw new Error(`Invalid 'storeCreatorContainer' supplied`);
    return store as ExtendedStore;
  }

  _send2Storage() {
    console.log(`Reduxed._send2Storage(): this.id=${this.id}; this.tmstamp=${this.tmstamp}; this.state=${JSON.stringify(this.state)}`);
    this.storage.save( packState(this.state, this.id, this.tmstamp) );
  }

  _send2StorageDelayd() {
    if (this.timerId)
      return;
    console.log(`Reduxed._send2StorageDelayd(): this.id=${this.id}`);
    this.timerId = setTimeout(() => {
      this._clearTimer();
      this._send2Storage();
    }, this.delay);
  }

  _clearTimer() {
    if (!this.timerId)
      return;
    console.log(`Reduxed._clearTimer(): this.id=${this.id}`);
    clearTimeout(this.timerId);
    this.timerId = 0;
  }

  _callListeners(local?: boolean, oldState?: any) {
    console.log(`Reduxed._callListeners(): local=${local}; oldState=${oldState}; n(lisners)=${this.lisners.length}`);
    local && this.lisner && this.lisner(this as ExtendedStore, oldState);
    for (const fn of this.lisners) {
      fn();
    }
  }

  getState() {
    console.log(`Reduxed.getState(): this.id=${this.id}; state=${this.state && JSON.stringify(this.state)}`);
    return this.state;
  }

  subscribe(fn: StandardListener): Unsubscribe {
    console.log(`Reduxed.subscribe(): this.id=${this.id}; i=${this.lisners.length}; fn=${typeof fn}`);
    typeof fn === 'function' && this.lisners.push(fn);
    return () => {
      console.log(`Reduxed.unsubscribe(): this.id=${this.id}; i=${this.lisners.length}; fn=${typeof fn}`);
      if (typeof fn === 'function') {
        this.lisners = this.lisners.filter(v => v !== fn);
      }
    };
  }

  dispatch(action: A | ActionExtension) {
    console.log(`Reduxed.dispatch(): this.id=${this.id}; action=${typeof action === 'function'? 'function' : JSON.stringify(action)}`);
    return this.store.dispatch(action);
  }

  replaceReducer(nextReducer: Reducer): ExtendedStore {
    if (typeof nextReducer === 'function') {
      this.store.replaceReducer(nextReducer);
    }
    return this as ExtendedStore;
  }

  [Symbol.observable](): Observable<any> {
    const getState = this.getState;
    const subscribe = this.subscribe;
    return {
      subscribe(observer: Observer<any>) {
        if (typeof observer !== 'object' || observer === null) {
          throw new TypeError('Expected the observer to be an object.')
        }
        function observeState() {
          const observerAsObserver = observer as Observer<any>
          observerAsObserver.next && observerAsObserver.next(getState());
        }
        observeState();
        const unsubscribe = subscribe(observeState);
        return { unsubscribe };
      },
      [Symbol.observable]() {
        return this
      }
    }
  }
}
