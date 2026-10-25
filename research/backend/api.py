"""Cortex² GCP service: authenticated experiments, EEG ingest, durable job supervision.
Required: Cloud Run, Firestore, Cloud Tasks, Secret Manager-backed provider keys.
No provider failures are disguised as successful simulations.
"""
from __future__ import annotations
import hashlib
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from typing import Literal
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from firebase_admin import initialize_app, firestore
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token
from google.cloud import tasks_v2
from google.protobuf import timestamp_pb2
import solver

app=FastAPI(title="cortex2 research service",version="0.1.0")
allowed=os.environ.get("CORS_ORIGINS","").split(",")
app.add_middleware(CORSMiddleware,allow_origins=[x for x in allowed if x],
                   allow_methods=["GET","POST"],allow_headers=["Authorization","Content-Type"])
initialize_app()
db=firestore.client()
PROJECT=os.environ.get("GOOGLE_CLOUD_PROJECT","")
REGION=os.environ.get("TASK_REGION","us-central1")
QUEUE=os.environ.get("TASK_QUEUE","cortex2-work")
WORKER_URL=os.environ.get("WORKER_URL","")
TASK_EMAIL=os.environ.get("TASK_SERVICE_ACCOUNT","")
CLIENT_ID=os.environ.get("GOOGLE_OAUTH_CLIENT_ID","")
GPT_MODEL=os.environ.get("GPT_MODEL","gpt-6.1")

class JobRequest(BaseModel):
    provider: Literal["classical","ibm_simulator","ibm_quantum","extropic_simulator"]
    kind: Literal["inverse_search"]="inverse_search"
    title: str=Field(default="8-bit neural inverse search",max_length=160)

class CommandRequest(BaseModel):
    command: str=Field(min_length=5,max_length=2000)

class IngestFrame(BaseModel):
    channel: str=Field(default="openbci",max_length=40)
    alpha: float=Field(ge=0,le=100)
    beta: float=Field(ge=0,le=100)
    theta: float=Field(ge=0,le=100)
    delta: float=Field(ge=0,le=100)
    quality: str=Field(default="unverified",max_length=50)
    samples: list[float]=Field(min_length=1,max_length=256)

def now():return datetime.now(timezone.utc)
def user_from_header(authorization: str=Header(default="")):
    if not CLIENT_ID:raise HTTPException(503,"google sign-in not configured")
    try:
        scheme,raw=authorization.split(" ",1)
        if scheme.lower()!="bearer":raise ValueError("expected bearer")
        claims=id_token.verify_oauth2_token(raw,GoogleRequest(),CLIENT_ID)
        if not claims.get("email_verified"):raise ValueError("google email not verified")
        return {"uid":claims["sub"],"email":claims.get("email"),"name":claims.get("name")}
    except Exception as exc:raise HTTPException(401,"invalid google id token") from exc

def internal_identity(authorization: str=Header(default="")):
    if not WORKER_URL or not TASK_EMAIL:raise HTTPException(503,"worker identity not configured")
    try:
        scheme,raw=authorization.split(" ",1)
        if scheme.lower()!="bearer":raise ValueError()
        claims=id_token.verify_oauth2_token(raw,GoogleRequest(),WORKER_URL)
        if claims.get("email") != TASK_EMAIL:raise ValueError("unexpected worker account")
    except Exception as exc:raise HTTPException(403,"worker service identity rejected") from exc

def doc_json(doc):
    v=doc.to_dict() or {}
    v["id"]=doc.id
    return v

def enqueue(job_id: str,uid:str,step="execute",delay=0,attempt=0):
    if not (PROJECT and WORKER_URL and TASK_EMAIL):
        raise RuntimeError("Cloud Tasks is not configured: set GOOGLE_CLOUD_PROJECT, WORKER_URL, TASK_SERVICE_ACCOUNT")
    client=tasks_v2.CloudTasksClient()
    parent=client.queue_path(PROJECT,REGION,QUEUE)
    payload=json.dumps({"job_id":job_id,"uid":uid,"step":step,"attempt":attempt}).encode()
    name=client.task_path(PROJECT,REGION,QUEUE,f"{job_id}-{step}-{attempt}")
    task={"name":name,"http_request":{"http_method":tasks_v2.HttpMethod.POST,
          "url":WORKER_URL,"headers":{"Content-Type":"application/json"},
          "oidc_token":{"service_account_email":TASK_EMAIL,"audience":WORKER_URL},
          "body":payload}}
    if delay:
        ts=timestamp_pb2.Timestamp()
        ts.FromDatetime(now()+timedelta(seconds=delay))
        task["schedule_time"]=ts
    try:client.create_task(request={"parent":parent,"task":task})
    except Exception as exc:
        from google.api_core.exceptions import AlreadyExists
        if not isinstance(exc,AlreadyExists):raise

def make_job(uid:str,provider:str,title:str,kind="inverse_search"):
    job_id=uuid4().hex
    record={"owner":uid,"provider":provider,"title":title,"kind":kind,
            "status":"queued","created_at":now().isoformat(),"updated_at":now().isoformat(),
            "attempt":0,"result":None,"error":None}
    ref=db.collection("research_jobs").document(job_id)
    ref.create(record)
    try:enqueue(job_id,uid)
    except Exception as exc:
        ref.update({"status":"failed","error":f"failed to enqueue: {exc}","updated_at":now().isoformat()})
        raise HTTPException(503,"queue unavailable") from exc
    return {"id":job_id,**record}

def append_analysis(uid,kind,text,job_id=None):
    ref=db.collection("research_analyses").document()
    obj={"owner":uid,"kind":kind,"text":text[:6000],"job_id":job_id,
         "time":now().isoformat()}
    ref.create(obj)
    return {"id":ref.id,**obj}

@app.get("/v1/me")
def me(user=Depends(user_from_header)):return user

@app.get("/v1/jobs")
def list_jobs(user=Depends(user_from_header)):
    docs=db.collection("research_jobs").where("owner","==",user["uid"]).limit(100).stream()
    return {"jobs":sorted([doc_json(d) for d in docs],key=lambda x:x.get("created_at",""),reverse=True)[:50]}

@app.post("/v1/jobs")
def new_job(req:JobRequest,user=Depends(user_from_header)):
    # Physical QPU uses explicit submission through this authenticated route.
    return {"job":make_job(user["uid"],req.provider,req.title,req.kind),
            "message":"job queued; inspect provider status in the sidebar"}

@app.get("/v1/analyses")
def analyses(user=Depends(user_from_header)):
    docs=db.collection("research_analyses").where("owner","==",user["uid"]).limit(100).stream()
    return {"analyses":sorted([doc_json(d) for d in docs],key=lambda x:x.get("time",""),reverse=True)[:50]}

@app.post("/v1/agent/commands")
def command(req:CommandRequest,user=Depends(user_from_header)):
    a=append_analysis(user["uid"],"research request",req.command)
    job=make_job(user["uid"],"agent","research operator command","agent")
    db.collection("research_jobs").document(job["id"]).update({"command":req.command})
    return {"analysis":a,"job":job,"message":"agent work scheduled, persisted in firestore"}

@app.post("/v1/eeg/ingest-token")
def ingest_token(user=Depends(user_from_header)):
    raw=secrets.token_urlsafe(32)
    digest=hashlib.sha256(raw.encode()).hexdigest()
    db.collection("research_ingest_tokens").document(digest).create({
        "owner":user["uid"],"expires_at":(now()+timedelta(minutes=45)).isoformat()})
    return {"token":raw,"expires_in_seconds":2700,
            "message":"paste only into local acquisition bridge; do not put in a url"}

@app.post("/v1/eeg/ingest")
def ingest(frame:IngestFrame,authorization:str=Header(default="")):
    token=authorization.removeprefix("Bearer ").strip()
    if not token:raise HTTPException(401,"missing device token")
    doc=db.collection("research_ingest_tokens").document(hashlib.sha256(token.encode()).hexdigest()).get()
    if not doc.exists:raise HTTPException(403,"device token invalid")
    item=doc.to_dict()
    if datetime.fromisoformat(item["expires_at"])<now():raise HTTPException(403,"device token expired")
    owner=item["owner"]
    db.collection("research_streams").document(owner).set({
        "owner":owner,"channel":frame.channel,"alpha":frame.alpha,"beta":frame.beta,
        "theta":frame.theta,"delta":frame.delta,"quality":frame.quality,
        "samples":frame.samples,"updated_at":now().isoformat()})
    return {"ok":True}

@app.get("/v1/eeg/latest")
def eeg(user=Depends(user_from_header)):
    doc=db.collection("research_streams").document(user["uid"]).get()
    if not doc.exists:return {"live":False,"signal":None}
    data=doc.to_dict()
    fresh=now()-datetime.fromisoformat(data["updated_at"])<timedelta(seconds=15)
    return {"live":fresh,"signal":data if fresh else None}

class TaskMessage(BaseModel):
    job_id:str
    uid:str
    step:Literal["execute","poll"]="execute"
    attempt:int=Field(ge=0,le=30)

def run_agent(uid,command):
    from openai import OpenAI
    recent=sorted([doc_json(x) for x in db.collection("research_jobs").where("owner","==",uid).limit(40).stream()],
                   key=lambda x:x.get("created_at",""),reverse=True)[:12]
    compact=[{"id":j["id"],"provider":j.get("provider"),"status":j.get("status"),
              "objective":j.get("objective"),"error":j.get("error")} for j in recent]
    rules=("You are a careful neuroscience research operator. "
           "Only report actual tool/provider measurements. Do not claim brain-source localization or quantum advantage. "
           "Reply with concise scientific interpretation and a recommended next job. "
           "Never execute arbitrary code or invent provider job identifiers.")
    response=OpenAI().responses.create(
        model=GPT_MODEL,instructions=rules,
        input=json.dumps({"user_command":command,"recent_jobs":compact,"known_scientific_scope":"synthetic four-parameter inverse model"}))
    return response.output_text

@app.post("/internal/execute",dependencies=[Depends(internal_identity)])
def execute(task:TaskMessage):
    ref=db.collection("research_jobs").document(task.job_id)
    snapshot=ref.get()
    if not snapshot.exists or snapshot.to_dict().get("owner")!=task.uid:
        raise HTTPException(404,"job missing")
    state=snapshot.to_dict()
    if state["status"] in ("completed","failed","cancelled"):return {"already_terminal":True}
    if task.step=="execute" and state["status"]!="queued":return {"already_dispatched":True}
    if task.step=="poll" and state["status"]!="submitted":return {"not_pollable":True}
    if task.step=="execute":
        # Idempotency: transactionally acquire queued -> running before external dispatch.
        @firestore.transactional
        def acquire(tx):
            s=ref.get(transaction=tx)
            if s.to_dict().get("status")!="queued":return False
            tx.update(ref,{"status":"running","updated_at":now().isoformat()})
            return True
        if not acquire(db.transaction()):return {"already_claimed":True}
    try:
        if task.step=="poll":
            result=solver.poll_ibm(state["provider_job_id"],solver.make_problem())
            if result["status"]=="submitted":
                enqueue(task.job_id,task.uid,"poll",delay=min(120,20*(task.attempt+1)),attempt=task.attempt+1)
                return {"status":"pending"}
            summary=result["result"]
        elif state["kind"]=="agent":
            message=run_agent(task.uid,state.get("command",""))
            append_analysis(task.uid,"agent finding",message,task.job_id)
            ref.update({"status":"completed","result":{"text":message},"updated_at":now().isoformat()})
            return {"status":"completed"}
        elif state["provider"]=="ibm_quantum":
            submission=solver.submit_ibm(solver.make_problem())
            ref.update({"status":"submitted","provider_job_id":submission["provider_job_id"],
                        "backend":submission["backend"],"gate_count":submission["transpiled_gate_count"],
                        "updated_at":now().isoformat()})
            enqueue(task.job_id,task.uid,"poll",delay=25,attempt=1)
            return {"status":"submitted","provider_job_id":submission["provider_job_id"]}
        else:
            summary=solver.run(state["provider"])
        ref.update({"status":"completed","result":summary,
                    "objective":summary.get("objective"),"provider_job_id":summary.get("provider_job_id"),
                    "updated_at":now().isoformat()})
        append_analysis(task.uid,"experiment result",
                        f"{state['provider']}: best nonlinear residual {summary.get('objective'):.6f}. "
                        "Interpret as synthetic benchmark only.",task.job_id)
        return {"status":"completed"}
    except Exception as exc:
        ref.update({"status":"failed","error":str(exc)[:1000],"updated_at":now().isoformat()})
        append_analysis(task.uid,"job failure",f"{state['provider']}: {exc}",task.job_id)
        return {"status":"failed","detail":str(exc)}
