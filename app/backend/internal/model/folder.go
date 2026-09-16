package model

import "time"

type Folder struct {
	ID        int64
	Name      string
	ParentID  *int64
	Type      string // article, picture, notification, social
	CreatedAt time.Time
	UpdatedAt time.Time
}
