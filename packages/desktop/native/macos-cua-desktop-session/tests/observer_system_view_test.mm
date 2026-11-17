#include "observer_system_view.h"
#include <cassert>
#include <cstdio>
using namespace zody::cua::desktop_session;
int main(){
  ObserverSystemViewProof good;
  good.target_pid=777;good.actual_before=good.actual_after=good.cg_before=good.cg_after=888;
  good.target_window=40;good.direct_before=good.direct_after=99;
  good.seconds_before=good.seconds_after=10;good.micros_before=good.micros_after=5;
  good.complete=good.apple_anchor=good.exact_identifier=good.exact_system_path=true;
  assert(observer_system_view_may_omit(good));
  for(int i=0;i<15;++i){auto p=good;switch(i){
    case 0:p.complete=false;break;case 1:p.apple_anchor=false;break;
    case 2:p.exact_identifier=false;break;case 3:p.exact_system_path=false;break;
    case 4:p.actual_after=889;break;case 5:p.cg_after=889;break;case 6:p.cg_before=889;break;
    case 7:p.actual_before=p.actual_after=p.cg_before=p.cg_after=777;break;
    case 8:p.direct_after=100;break;case 9:p.direct_before=p.direct_after=40;break;
    case 10:p.seconds_after=11;break;case 11:p.micros_after=6;break;
    case 12:p.seconds_before=p.seconds_after=0;break;case 13:p.micros_before=p.micros_after=1000000;break;
    case 14:p.actual_before=0;break;
  }assert(!observer_system_view_may_omit(p));}
  good.micros_before=good.micros_after=0;assert(observer_system_view_may_omit(good));
  std::puts("observer-system-view: passed");return 0;
}
