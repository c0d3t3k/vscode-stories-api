require("dotenv-safe").config();
import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import createError from "http-errors";
import isUUID from "is-uuid";
import jwt from "jsonwebtoken";
import passport from "passport";
import { Strategy as GitHubStrategy } from "passport-github";
import { join } from "path";
import "reflect-metadata";
import { createConnection, getConnection } from "typeorm";
import { __prod__ } from "./constants";
import { createTokens } from "./createTokens";
import { Favorite } from "./entities/Favorite";
import { GifStory } from "./entities/GifStory";
import { Like } from "./entities/Like";
import { TextStory } from "./entities/TextStory";
import { User } from "./entities/User";
import { isAuth } from "./isAuth";

const upgradeMessage =
  "Upgrade the VSCode Stories extension, I fixed it and changed the API.";

const main = async () => {
  const prodCredentials = __prod__
    ? {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        username: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
      }
    : {};
  console.log("about to connect to db, host: ", process.env.DB_HOST);

  const conn = await createConnection({
    type: "postgres",
    database: "stories",
    entities: [join(__dirname, "./entities/*")],
    migrations: [join(__dirname, "./migrations/*")],
    // synchronize: !__prod__,
    logging: !__prod__,
    ...prodCredentials,
  });
  console.log("connected, running migrations now");
  await conn.runMigrations();
  console.log("migrations ran");

  passport.use(
    new GitHubStrategy(
      {
        clientID: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL: `${process.env.SERVER_URL}/auth/github/callback`,
      },
      async (githubAccessToken, _, profile, cb) => {
        if (profile.id === "32990164") {
          cb(new Error("you are banned"));
          return;
        }
        try {
          let user = await User.findOne({ githubId: profile.id });
          const data = {
            githubAccessToken,
            displayName: profile.displayName,
            githubId: profile.id,
            photoUrl:
              profile.photos?.[0].value ||
              (profile._json as any).avatar_url ||
              "",
            other: profile._json,
            profileUrl: profile.profileUrl,
            username: profile.username,
          };
          if (user) {
            await User.update(user.id, data);
          } else {
            user = await User.create(data).save();
          }

          cb(undefined, createTokens(user));
        } catch (err) {
          console.log(err);
          cb(new Error("internal error"));
        }
      }
    )
  );
  passport.serializeUser((user: any, done) => {
    done(null, user.accessToken);
  });

  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: "*", maxAge: 86400 }));
  app.use(bodyParser.json());
  app.use(passport.initialize());

  app.get("/auth/github", passport.authenticate("github", { session: false }));

  app.get(
    "/auth/github/callback",
    passport.authenticate("github"),
    (req: any, res) => {
      if (!req.user.accessToken || !req.user.refreshToken) {
        res.send(`something went wrong`);
        return;
      }
      res.redirect(
        `http://localhost:54321/callback/${req.user.accessToken}/${req.user.refreshToken}`
      );
    }
  );

  app.get("/story/likes/:id", async (_req, _res, next) => {
    return next(createError(400, upgradeMessage));
  });

  app.get("/stories/hot/:cursor?", async (_, __, next) => {
    return next(createError(400, upgradeMessage));
  });

  app.get("/gif-story/:id", isAuth(false), async (req: any, res) => {
    const { id } = req.params;
    if (!id || !isUUID.v4(id)) {
      res.json({ story: null });
    } else {
      const replacements = [id];
      if (req.userId) {
        replacements.push(req.userId);
      }
      res.json({
        story: (
          await getConnection().query(
            `
      select ts.*, l."gifStoryId" is not null "hasLiked" from gif_story ts
      left join "favorite" l on l."gifStoryId" = ts.id ${
        req.userId ? `and l."userId" = $2` : ""
      }
      where id = $1
      `,
            replacements
          )
        )[0],
      });
    }
  });
  app.get("/text-story/:id", isAuth(false), async (req: any, res) => {
    const { id } = req.params;
    if (!id || !isUUID.v4(id)) {
      res.json({ story: null });
    } else {
      const replacements = [id];
      if (req.userId) {
        replacements.push(req.userId);
      }
      res.json({
        story: (
          await getConnection().query(
            `
      select ts.*, l."textStoryId" is not null "hasLiked" from text_story ts
      left join "like" l on l."textStoryId" = ts.id ${
        req.userId ? `and l."userId" = $2` : ""
      }
      where id = $1
      `,
            replacements
          )
        )[0],
      });
    }
  });
  app.get("/gif-stories/hot/:cursor?", async (req, res) => {
    let cursor = 0;
    if (req.params.cursor) {
      const nCursor = parseInt(req.params.cursor);
      if (!Number.isNaN(nCursor)) {
        cursor = nCursor;
      }
    }
    const limit = 21;
    const stories = await getConnection().query(`
      select
      ts.id,
      u.username "creatorUsername",
      u."photoUrl" "creatorAvatarUrl",
      u.flair
      from gif_story ts
      inner join "user" u on u.id = ts."creatorId"
      order by (ts."numLikes"+1) / power(EXTRACT(EPOCH FROM current_timestamp-ts."createdAt")/3600,1.8) DESC
      limit ${limit + 1}
      ${cursor ? `offset ${limit * cursor}` : ""}
    `);

    const data = {
      stories: stories.slice(0, limit),
      hasMore: stories.length === limit + 1,
    };
    res.json(data);
  });
  app.get("/text-stories/hot/:cursor?", async (req, res) => {
    let cursor = 0;
    if (req.params.cursor) {
      const nCursor = parseInt(req.params.cursor);
      if (!Number.isNaN(nCursor)) {
        cursor = nCursor;
      }
    }
    const limit = 21;
    const stories = await getConnection().query(`
      select
      ts.id,
      u.username "creatorUsername",
      u."photoUrl" "creatorAvatarUrl",
      u.flair
      from text_story ts
      inner join "user" u on u.id = ts."creatorId"
      order by (ts."numLikes"+1) / power(EXTRACT(EPOCH FROM current_timestamp-ts."createdAt")/3600,1.8) DESC
      limit ${limit + 1}
      ${cursor ? `offset ${limit * cursor}` : ""}
    `);

    const data = {
      stories: stories.slice(0, limit),
      hasMore: stories.length === limit + 1,
    };
    res.json(data);
  });

  app.post("/delete-gif-story/:id", isAuth(), async (req: any, res) => {
    const { id } = req.params;
    if (!isUUID.v4(id)) {
      res.send({ ok: false });
      return;
    }

    const criteria: Partial<GifStory> = { id };

    if (req.userId !== "dac7eb0f-808b-4842-b193-5d68cc082609") {
      criteria.creatorId = req.userId;
    }

    await GifStory.delete(criteria);
    res.send({ ok: true });
  });

  app.post("/delete-text-story/:id", isAuth(), async (req: any, res) => {
    const { id } = req.params;
    if (!isUUID.v4(id)) {
      res.send({ ok: false });
      return;
    }

    const criteria: Partial<TextStory> = { id };

    if (req.userId !== "dac7eb0f-808b-4842-b193-5d68cc082609") {
      criteria.creatorId = req.userId;
    }

    await TextStory.delete(criteria);
    res.send({ ok: true });
  });

  app.post("/unlike-text-story/:id", isAuth(), async (req: any, res, next) => {
    const { id } = req.params;
    if (!isUUID.v4(id)) {
      res.send({ ok: false });
      return;
    }
    try {
      const { affected } = await Like.delete({
        textStoryId: id,
        userId: req.userId,
      });
      if (affected) {
        await TextStory.update(id, { numLikes: () => '"numLikes" - 1' });
      }
    } catch (err) {
      console.log(err);
      return next(createError(400, "You probably already liked this"));
    }

    res.send({ ok: true });
  });
  app.post("/like-text-story/:id", isAuth(), async (req: any, res, next) => {
    const { id } = req.params;
    if (!isUUID.v4(id)) {
      res.send({ ok: false });
      return;
    }
    try {
      await Like.insert({ textStoryId: id, userId: req.userId });
    } catch (err) {
      console.log(err);
      return next(createError(400, "You probably already liked this"));
    }

    await TextStory.update(id, { numLikes: () => '"numLikes" + 1' });

    res.send({ ok: true });
  });
  app.post("/like-gif-story/:id", isAuth(), async (req: any, res, next) => {
    const { id } = req.params;
    if (!isUUID.v4(id)) {
      res.send({ ok: false });
      return;
    }
    try {
      await Favorite.insert({ gifStoryId: id, userId: req.userId });
    } catch (err) {
      console.log(err);
      return next(createError(400, "You probably already liked this"));
    }

    await GifStory.update(id, { numLikes: () => '"numLikes" + 1' });

    res.send({ ok: true });
  });

  app.post("/like-story/:id/:username", async (_req, _res, next) => {
    return next(createError(400, upgradeMessage));
  });
  const maxTextLength = 20000;
  app.post(
    "/new-text-story",
    isAuth(),
    rateLimit({
      keyGenerator: (req: any) => req.userId,
      windowMs: 43200000, // 12 hours
      message: "Limit reached. You can only post 10 stories a day.",
      max: 10,
      headers: false,
    }),
    async (req, res) => {
      let { text, programmingLanguageId, filename, recordingSteps } = req.body;
      if (text.length > maxTextLength) {
        text = text.slice(0, maxTextLength);
      }
      if (programmingLanguageId.length > 40) {
        programmingLanguageId = null;
      }
      if (filename.length > 100) {
        filename = "untitled";
      }
      const ts = await TextStory.create({
        text,
        filename,
        recordingSteps,
        programmingLanguageId,
        creatorId: (req as any).userId,
      }).save();
      const currentUser = await User.findOneOrFail((req as any).userId);

      res.send({
        id: ts.id,
        creatorUsername: currentUser.username,
        creatorAvatarUrl: currentUser.photoUrl,
        flair: currentUser.flair,
      });
    }
  );

  app.post(
    "/new-gif-story",
    isAuth(),
    rateLimit({
      keyGenerator: (req: any) => req.userId,
      windowMs: 43200000, // 12 hours
      message: "Limit reached. You can only post 10 stories a day.",
      max: 10,
      headers: false,
    }),
    async (req, res, next) => {
      let { token, programmingLanguageId } = req.body;
      if (programmingLanguageId.length > 40) {
        programmingLanguageId = null;
      }
      let filename: string = "";
      let flagged = null;
      try {
        const payload: any = jwt.verify(token, process.env.TOKEN_SECRET);
        filename = payload.filename;
        flagged = payload.flagged;
      } catch (err) {
        console.log("tokenErr: ", err);
        return next(createError(400, "something went wrong uploading gif"));
      }
      if (!filename) {
        return next(
          createError(400, "something went really wrong uploading gif")
        );
      }
      // @todo if flagged ping me on slack
      const gs = await GifStory.create({
        mediaId: filename,
        flagged,
        programmingLanguageId,
        creatorId: (req as any).userId,
      }).save();
      const currentUser = await User.findOneOrFail((req as any).userId);

      res.send({
        id: gs.id,
        creatorUsername: currentUser.username,
        mediaId: filename,
        creatorAvatarUrl: currentUser.photoUrl,
        flair: currentUser.flair,
      });
    }
  );

  app.post("/new-story", async (_req, _res, next) => {
    return next(createError(400, upgradeMessage));
  });

  app.post("/update-flair", isAuth(), async (req, res) => {
    if (
      !req.body.flair ||
      typeof req.body.flair !== "string" ||
      req.body.flair.length > 40
    ) {
      res.json({ ok: false });
      return;
    }
    await User.update({ id: (req as any).userId }, { flair: req.body.flair });
    res.json({ ok: true });
  });

  app.use((err: any, _: any, res: any, next: any) => {
    if (res.headersSent) {
      return next(err);
    }
    if (err.statusCode) {
      res.status(err.statusCode).send(err.message);
    } else {
      console.log(err);
      res.status(500).send("internal server error");
    }
  });

  app.listen(8080, () => {
    console.log("server started");
  });
};

main();
