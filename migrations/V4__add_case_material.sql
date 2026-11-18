-- 案例分析题：题目与作答快照都保存案例材料，保证题目脱离共用材料也能作答。
ALTER TABLE questions ADD COLUMN material TEXT NULL AFTER score;
ALTER TABLE answers ADD COLUMN material TEXT NULL AFTER score;
