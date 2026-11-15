-- 쉐어(직관·카풀·티켓양도) 휴대폰 번호(선택) 추가
-- Supabase SQL Editor에 통째로 붙여넣고 한 번 실행하세요. 여러 번 실행해도 안전합니다.
-- 동작: 글쓴이/참여자가 번호를 선택 입력 → 승인된 상대에게만 공개 → 거절·취소·추방·글 삭제 시 번호 자동 삭제.

begin;

alter table public.meetup_contacts add column if not exists phone text not null default '';
alter table public.meetup_requests add column if not exists phone text not null default '';

-- 번호 정리/검증: 숫자만 남기고 휴대폰 형식(01X, 10~11자리)만 허용, 빈 값은 허용
create or replace function public._mt_phone(p text)
returns text language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g');
begin
  if d = '' then return ''; end if;
  if d !~ '^01[016789][0-9]{7,8}$' then raise exception 'E:휴대폰 번호 형식이 올바르지 않습니다'; end if;
  return d;
end $$;

-- 신청이 취소/거절/추방되면 번호 자동 삭제 (기존 함수를 고치지 않고 한 곳에서 처리)
create or replace function public._mt_clear_req_phone()
returns trigger language plpgsql as $$
begin
  if new.status in ('cancelled', 'rejected', 'kicked') then new.phone := ''; end if;
  return new;
end $$;
drop trigger if exists mt_req_clear_phone on public.meetup_requests;
create trigger mt_req_clear_phone before insert or update on public.meetup_requests
  for each row execute function public._mt_clear_req_phone();

-- 글을 삭제하면 작성자 번호도 삭제
create or replace function public._mt_clear_post_phone()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.status = 'deleted' and old.status is distinct from 'deleted' then
    update public.meetup_contacts set phone = '' where post_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists mt_post_clear_phone on public.meetup_posts;
create trigger mt_post_clear_phone after update of status on public.meetup_posts
  for each row execute function public._mt_clear_post_phone();

CREATE OR REPLACE FUNCTION public.meetup_create_post(p jsonb, p_agreed boolean, p_test text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare uid uuid := _mt_uid(p_test); nick text; ev text; cat text; n jsonb; newid bigint; ph text;
begin
  nick := _mt_nick(p_test); perform _mt_check_ban(uid);
  if p_agreed is not true then raise exception 'E:이용 안내와 면책 내용에 동의해야 글을 등록할 수 있습니다'; end if;
  ev := p->>'event_key'; cat := p->>'category';
  perform _mt_event_open(ev);
  if cat not in ('watch','carpool','ticket') then raise exception 'E:글 종류가 올바르지 않습니다'; end if;
  if (select count(*) from meetup_posts where author_uid = uid and created_at > now() - interval '1 day') >= 8 then
    raise exception 'E:하루에 등록할 수 있는 글 수를 넘었습니다';
  end if;
  if exists (select 1 from meetup_posts where event_key = ev and author_uid = uid and category = cat and status in ('open','full','hidden')
             and (cat <> 'ticket' or coalesce(tk_kind,'판매') = coalesce(nullif(p->>'tk_kind',''),'판매'))) then
    raise exception 'E:이 경기에 같은 종류의 진행 중인 글이 이미 있습니다. 기존 글을 수정하거나 마감한 뒤 다시 등록해주세요';
  end if;
  n := _mt_norm(p, ev, cat, null);
  ph := _mt_phone(p->>'phone');
  begin
    insert into meetup_posts(event_key, category, author_uid, author_nick, gender, age_group, age_prefs, gender_pref,
        people, my_people, capacity, cp_kind, origin, origin_detail, trip, fare, grade, seat_zone, seat_row, seat_num, seat_key,
        unit_price, sell_qty, sell_price, tk_kind, note)
      values (ev, cat, uid, nick, n->>'gender', n->>'age_group', array(select jsonb_array_elements_text(n->'age_prefs')), coalesce(n->>'gender_pref','무관'),
        (n->>'people')::int, (n->>'my_people')::int, (n->>'capacity')::int, n->>'cp_kind', n->>'origin', coalesce(n->>'origin_detail',''), n->>'trip', (n->>'fare')::int,
        n->>'grade', n->>'seat_zone', n->>'seat_row', n->>'seat_num', n->>'seat_key',
        (n->>'unit_price')::int, (n->>'sell_qty')::int, (n->>'sell_price')::int, n->>'tk_kind', n->>'note')
      returning id into newid;
  exception when unique_violation then
    raise exception 'E:이미 같은 종류의 글이 있거나 같은 좌석이 등록되어 있습니다';
  end;
  insert into meetup_contacts(post_id, kind, value, phone) values (newid, n->>'contact_kind', n->>'contact_value', ph);
  return jsonb_build_object('ok', true, 'id', newid);
end $function$;

CREATE OR REPLACE FUNCTION public.meetup_update_post(p_id bigint, p jsonb, p_test text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare uid uuid := _mt_uid(p_test); po meetup_posts; n jsonb; appr int; cap int; ph text;
begin
  perform _mt_nick(p_test); perform _mt_check_ban(uid);
  select * into po from meetup_posts where id = p_id and author_uid = uid;
  if po.id is null or po.status not in ('open','full') then raise exception 'E:수정할 수 없는 글입니다'; end if;
  perform _mt_event_open(po.event_key);
  if po.category = 'ticket' then p := jsonb_set(p, '{tk_kind}', to_jsonb(coalesce(po.tk_kind, '판매'))); end if;
  n := _mt_norm(p, po.event_key, po.category, po.id);
  ph := _mt_phone(p->>'phone');
  cap := (n->>'capacity')::int;
  select coalesce(sum(party),0) into appr from meetup_requests where post_id = po.id and status = 'approved';
  if appr > cap then raise exception 'E:이미 %명이 승인되어 있어요. 승인된 인원보다 적게 줄일 수 없어요 (참여자를 추방한 뒤 수정해주세요)', appr; end if;
  begin
    update meetup_posts set
      gender = n->>'gender', age_group = n->>'age_group', age_prefs = array(select jsonb_array_elements_text(n->'age_prefs')),
      gender_pref = coalesce(n->>'gender_pref','무관'), people = (n->>'people')::int, my_people = (n->>'my_people')::int, capacity = cap,
      cp_kind = n->>'cp_kind', origin = n->>'origin', origin_detail = coalesce(n->>'origin_detail',''), trip = n->>'trip', fare = (n->>'fare')::int,
      grade = n->>'grade', seat_zone = n->>'seat_zone', seat_row = n->>'seat_row', seat_num = n->>'seat_num', seat_key = n->>'seat_key',
      unit_price = (n->>'unit_price')::int, sell_qty = (n->>'sell_qty')::int, sell_price = (n->>'sell_price')::int,
      note = n->>'note',
      status = case when appr >= cap then 'full' else 'open' end
    where id = po.id;
  exception when unique_violation then
    raise exception 'E:같은 좌석의 양도 글이 이미 등록되어 있습니다';
  end;
  update meetup_contacts set kind = n->>'contact_kind', value = n->>'contact_value', phone = ph where post_id = po.id;
  if appr >= cap then
    update meetup_requests set status = 'cancelled', decided_at = now(), contact_value = '' where post_id = po.id and status = 'pending';
  end if;
  return jsonb_build_object('ok', true);
end $function$;

CREATE OR REPLACE FUNCTION public.meetup_contacts(p_post_id bigint, p_test text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare uid uuid := _mt_uid(p_test); po meetup_posts; c meetup_contacts;
begin
  perform _mt_nick(p_test); perform _mt_check_ban(uid);
  select * into po from meetup_posts where id = p_post_id;
  if po.id is null or po.status in ('hidden','deleted') then raise exception 'E:열람할 수 없는 글입니다'; end if;
  if po.author_uid = uid then
    select * into c from meetup_contacts where post_id = po.id;
    return jsonb_build_object('role', 'author', 'own', jsonb_build_object('kind', c.kind, 'value', c.value, 'phone', coalesce(c.phone, '')), 'applicants', coalesce((
      select jsonb_agg(jsonb_build_object('request_id', r.id, 'nick', r.applicant_nick,
              'kind', r.contact_kind, 'value', r.contact_value, 'phone', coalesce(r.phone, '')) order by r.decided_at)
      from meetup_requests r where r.post_id = po.id and r.status = 'approved'), '[]'::jsonb));
  end if;
  if exists (select 1 from meetup_requests r where r.post_id = po.id and r.applicant_uid = uid and r.status = 'approved') then
    select * into c from meetup_contacts where post_id = po.id;
    return jsonb_build_object('role', 'member', 'nick', po.author_nick, 'kind', c.kind, 'value', c.value, 'phone', coalesce(c.phone, ''));
  end if;
  raise exception 'E:작성자의 승인 후에 연락 수단을 볼 수 있습니다';
end $function$;

-- meetup_apply: 인자가 하나 늘어나므로 예전 시그니처를 먼저 지운다(겹쳐 있으면 호출이 모호해짐)
drop function if exists public.meetup_apply(bigint, text, text, text, text, text, boolean, integer, text);

CREATE OR REPLACE FUNCTION public.meetup_apply(p_post_id bigint, p_gender text, p_age_group text, p_message text, p_contact_kind text, p_contact_value text, p_agreed boolean, p_party integer DEFAULT 1, p_test text DEFAULT NULL::text, p_phone text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare uid uuid := _mt_uid(p_test); nick text; po meetup_posts; msg text; cv text; ck text; r meetup_requests; g text; ag text; pty int := 1; left_n int; ph text;
begin
  nick := _mt_nick(p_test); perform _mt_check_ban(uid);
  if p_agreed is not true then raise exception 'E:이용 안내와 면책 내용에 동의해야 신청할 수 있습니다'; end if;
  select * into po from meetup_posts where id = p_post_id;
  if po.id is null or po.status <> 'open' then raise exception 'E:모집 중인 글이 아닙니다'; end if;
  perform _mt_event_open(po.event_key);
  if po.author_uid = uid then raise exception 'E:내 글에는 신청할 수 없습니다'; end if;
  if exists (select 1 from meetup_blocks b where (b.blocker_uid = uid and b.blocked_uid = po.author_uid)
                                              or (b.blocker_uid = po.author_uid and b.blocked_uid = uid)) then
    raise exception 'E:신청할 수 없는 글입니다';
  end if;
  if po.category = 'ticket' then
    g := null; ag := null;                                  -- 티켓 양도는 성별/나이대 불필요
  else
    g := p_gender; ag := p_age_group;
    if g not in ('남자','여자') or ag not in ('10대','20대','30대','40대 이상') then raise exception 'E:성별/나이대를 선택해주세요'; end if;
    if po.gender_pref = '동성만' and g <> po.gender then raise exception 'E:작성자가 동성만 모집하는 글입니다'; end if;
    if po.gender_pref in ('남자','여자') and g <> po.gender_pref then raise exception 'E:작성자가 %만 모집하는 글입니다', po.gender_pref; end if;
    if array_length(po.age_prefs, 1) > 0 and not (ag = any(po.age_prefs)) then
      raise exception 'E:작성자가 % 연령대만 모집하는 글입니다', array_to_string(po.age_prefs, ', ');
    end if;
  end if;

  if po.category = 'watch' or (po.category = 'carpool' and po.cp_kind = '모집') then
    pty := coalesce(p_party, 1);
    if pty not between 1 and 30 then raise exception 'E:신청 인원은 1~30명입니다'; end if;
    select po.capacity - coalesce(sum(party),0) into left_n from meetup_requests where post_id = po.id and status = 'approved';
    if pty > left_n then raise exception 'E:남은 자리(%명)보다 많은 인원은 신청할 수 없어요', greatest(left_n,0); end if;
  end if;
  msg := btrim(coalesce(p_message,'')); cv := btrim(coalesce(p_contact_value,'')); ck := coalesce(nullif(p_contact_kind,''), 'openkakao');
  if char_length(msg) > 50 then raise exception 'E:한마디는 50자까지 쓸 수 있습니다'; end if;
  if _mt_bad_text(msg) then raise exception 'E:한마디에 금지된 표현(계좌/입금/링크/연락처 등)이 있습니다'; end if;
  if cv <> '' and not _mt_valid_contact(ck, cv) then raise exception 'E:연락 수단 형식이 올바르지 않습니다'; end if;   -- 연락처는 선택
  ph := _mt_phone(p_phone);   -- 휴대폰 번호는 선택(형식만 확인)
  if (select count(*) from meetup_requests where applicant_uid = uid and created_at > now() - interval '1 day') >= 20 then
    raise exception 'E:하루에 보낼 수 있는 신청 수를 넘었습니다';
  end if;

  select * into r from meetup_requests where post_id = p_post_id and applicant_uid = uid;
  if r.id is not null then
    if r.status in ('pending','approved') then raise exception 'E:이미 신청한 글입니다'; end if;
    if r.status in ('rejected','kicked') then raise exception 'E:이 글에는 다시 신청할 수 없습니다'; end if;
    update meetup_requests set status = 'pending', gender = g, age_group = ag, message = msg, party = pty,
           contact_kind = ck, contact_value = cv, phone = ph, agreed_at = now(), created_at = now(), decided_at = null
     where id = r.id;   -- 취소했던 신청 재신청
  else
    insert into meetup_requests(post_id, applicant_uid, applicant_nick, gender, age_group, message, contact_kind, contact_value, phone, party)
    values (p_post_id, uid, nick, g, ag, msg, ck, cv, ph, pty);
  end if;
  return jsonb_build_object('ok', true);
end $function$;

grant execute on function public.meetup_apply(bigint, text, text, text, text, text, boolean, integer, text, text) to anon, authenticated;

commit;
