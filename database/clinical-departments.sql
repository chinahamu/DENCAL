INSERT INTO departments(code, name) VALUES
    ('demo-general', '総合診療科'),
    ('demo-specialty', '専門外来')
ON CONFLICT(code) DO NOTHING;

UPDATE staff
SET department_id = (SELECT id FROM departments WHERE code = 'demo-general')
WHERE department_id IS NULL AND (
    (staff_code = 'demo-physician' AND role = 'physician') OR
    (staff_code = 'demo-nurse' AND role = 'nurse') OR
    (staff_code = 'demo-reception' AND role = 'reception')
);

PRAGMA user_version = 3;
