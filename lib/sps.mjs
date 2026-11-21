// 从分片首包解析 H.264 SPS，得到真实分辨率（不依赖 ffprobe）
export function spsSize(buf){
  const n=buf.length;
  const starts=[];
  for(let i=0;i+3<n;i++){
    if(buf[i]===0&&buf[i+1]===0){
      if(buf[i+2]===1) { starts.push(i+3); i+=2; }
      else if(buf[i+2]===0&&buf[i+3]===1){ starts.push(i+4); i+=3; }
    }
  }
  for(let k=0;k<starts.length;k++){
    const off=starts[k];
    const type=buf[off]&0x1f;
    if(type!==7) continue;
    const end=k+1<starts.length?starts[k+1]-3:n;
    const r=parseSps(buf.subarray(off+1,Math.max(off+1,end)));
    if(r) return r;
  }
  return null;
}
function parseSps(b){
  const out=[];
  for(let i=0;i<b.length;i++){
    if(i+2<b.length&&b[i]===0&&b[i+1]===0&&b[i+2]===3){ out.push(0,0); i+=2; }
    else out.push(b[i]);
  }
  let bit=0;
  const u1=()=>{ const byte=out[bit>>3]; if(byte===undefined) throw 0; const v=(byte>>(7-(bit&7)))&1; bit++; return v; };
  const u=n=>{ let v=0; for(let i=0;i<n;i++) v=(v<<1)|u1(); return v; };
  const ue=()=>{ let z=0; while(u1()===0){ if(++z>32) throw 0; } return z===0?0:((1<<z)-1)+u(z); };
  const se=()=>{ const k=ue(); return (k&1)?((k+1)>>1):-(k>>1); };
  try{
    const profile=u(8); u(8); u(8);
    ue(); // sps id
    let chroma=1;
    if([100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profile)){
      chroma=ue();
      if(chroma===3) u1();
      ue(); ue(); u1();
      if(u1()){ // scaling matrix
        const cnt=chroma===3?12:8;
        for(let i=0;i<cnt;i++){ if(u1()){ const size=i<6?16:64; let last=8,next=8; for(let j=0;j<size;j++){ if(next!==0) next=(last+se()+256)%256; last=next===0?last:next; } } }
      }
    }
    ue(); // log2_max_frame_num
    const pocType=ue();
    if(pocType===0) ue();
    else if(pocType===1){ u1(); se(); se(); const c=ue(); for(let i=0;i<c;i++) se(); }
    ue(); // max_num_ref_frames
    u1(); // gaps
    const wMbs=ue()+1;
    const hMap=ue()+1;
    const frameMbsOnly=u1();
    if(!frameMbsOnly) u1();
    u1(); // direct8x8
    let cropL=0,cropR=0,cropT=0,cropB=0;
    if(u1()){ cropL=ue(); cropR=ue(); cropT=ue(); cropB=ue(); }
    const subW=chroma===1||chroma===2?2:1;
    const subH=chroma===1?2:(chroma===2?1:1);
    const cropUnitX=chroma===0?1:subW;
    const cropUnitY=(chroma===0?1:subH)*(2-frameMbsOnly);
    const width=wMbs*16-cropUnitX*(cropL+cropR);
    const height=(2-frameMbsOnly)*hMap*16-cropUnitY*(cropT+cropB);
    if(width>0&&height>0&&width<=7680&&height<=4320) return {width,height};
  }catch(e){}
  return null;
}
