import { Router, type IRouter } from "express";
import healthRouter from "./health";
import openaiRouter from "./openai";
import agentRouter from "./agent";
import voiceRouter from "./voice";
import filesRouter from "./files";

const router: IRouter = Router();

router.use(healthRouter);
router.use(agentRouter);
router.use(openaiRouter);
router.use(voiceRouter);
router.use(filesRouter);

export default router;
