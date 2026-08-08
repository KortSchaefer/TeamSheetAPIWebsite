INSERT INTO users (id,email,password_hash,full_name,role,employee_id,created_at,updated_at)
VALUES (901,'browser.manager@example.com','$pbkdf2-sha256$29000$d29ya2Vycy1maXh0dXJl$kNa9.hCgWiPN51HMmO7.KyQkbSrFwJw7OD.WoWdT6Kc','Browser Manager','MANAGER',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO inventory_locations(id,name,description,active,created_at,updated_at)
VALUES(910,'Synthetic Walk-In','Browser test',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO inventory_items(id,ingredient_id,name,category,sku,base_unit,purchase_unit,purchase_to_base,default_location_id,cost_cents,shelf_life_days,active,created_at,updated_at)
VALUES(920,NULL,'Synthetic Milk','Dairy','SYN-MILK','case','case',1,910,1200,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      (921,NULL,'Synthetic Chicken','Protein','SYN-CHICKEN','case','case',1,910,2400,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
