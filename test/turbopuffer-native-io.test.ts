import {describe,it,expect,vi} from 'vitest';
import {NativeHttpIo} from '../src/storage/turbopuffer-native/io.js';
describe('native HTTP caching and credential custody',()=>{
  it('never serializes the provider credential or caches a mutable head',async()=>{
    const io=new NativeHttpIo({apiKey:'synthetic-private-test-value',namespace:'native-io-test'});
    expect(JSON.stringify(io)).not.toContain('synthetic-private-test-value');
    let queries=0;
    vi.spyOn(io.client,'request').mockImplementation(async(_method,suffix,body:any)=>{
      if(suffix==='/query'){queries++;expect(body.consistency).toEqual({level:'strong'});return {rows:[{id:'head',kind:'head',payload:'new-head'}]};}
      return {rows_affected:2,rows_upserted:2};
    });
    await io.write({upsert_rows:[{id:'head',kind:'head',payload:'old-head'},{id:'r:immutable',kind:'record',payload:'immutable'}]});
    expect((await io.read(['r:immutable']))[0].payload).toBe('immutable');expect(queries).toBe(0);
    expect((await io.read(['head']))[0].payload).toBe('new-head');expect(queries).toBe(1);
  });
  it('does not treat skipped conditional upserts as acknowledged local values',async()=>{
    const io=new NativeHttpIo({apiKey:'synthetic-private-test-value',namespace:'native-io-test'});
    vi.spyOn(io.client,'request').mockImplementation(async(_method,suffix)=>suffix==='/query'?{rows:[{id:'r:existing',kind:'record',payload:'server-value'}]}:{rows_affected:0});
    await io.write({upsert_rows:[{id:'r:existing',kind:'record',payload:'unacknowledged-value'}],upsert_condition:['id','Eq',null]});
    expect((await io.read(['r:existing']))[0].payload).toBe('server-value');
  });
});
